// A direct connection between the two players, with the relay underneath it.
//
// Position updates are continuous, and continuous is the one traffic shape the
// relay is a bad fit for: every message is billed, and every message takes the
// long way round through Cloudflare instead of across the room. So they go peer
// to peer when the two of them can manage it.
//
// The usual reason not to do this is needing a TURN server for the pairs whose
// networks refuse a direct connection, which is a whole extra service. Here the
// relay already carries messages between exactly these two people, so it is the
// fallback, and only the pairs who need it cost anything.
import type { ClientMessage, RtcCandidate, ServerMessage } from "./protocol";
import type { Step } from "./presence";

/** Which way updates are currently travelling. */
export type Carrier = "direct" | "relay" | "connecting" | "none";

/**
 * A direct connection costs nothing per message, so it runs often enough that
 * the peer looks live. The relay is billed, so it says less and leans on the
 * receiver's interpolation to cover the gaps.
 */
export const DIRECT_INTERVAL_MS = 50;
export const RELAY_INTERVAL_MS = 300;

/** Public STUN only. Anything that needs relaying uses the relay we already have. */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

/** Long enough for ICE on a slow network, short enough not to feel broken. */
const CONNECT_TIMEOUT_MS = 12000;

export interface PeerLinkHooks {
  /** Put a signalling message on the relay. */
  signal(msg: ClientMessage): void;
  /** Carry one step over the relay, for when there is no direct connection. */
  viaRelay(step: Step): void;
  /** A step arrived, by whichever route. */
  onStep(step: Step): void;
  /** The route changed, so the send rate and the diagnostics follow it. */
  onCarrier(carrier: Carrier): void;
}

export class PeerLink {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private state: Carrier = "none";
  private timer: number | null = null;
  private closed = false;
  /** Candidates that turned up before the answer did. */
  private pending: RtcCandidate[] = [];
  private remoteReady = false;

  constructor(
    /** Character A offers and B answers, so the two never offer at each other. */
    private readonly isOfferer: boolean,
    private readonly hooks: PeerLinkHooks,
  ) {}

  get carrier(): Carrier {
    return this.state;
  }

  /** Both peers are in the room, so a direct connection is worth trying. */
  start(): void {
    if (this.closed || this.pc) return;
    this.setCarrier("connecting");
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;

    pc.addEventListener("icecandidate", (e) => {
      if (!e.candidate) return;
      this.hooks.signal({
        t: "rtc-ice",
        candidate: {
          candidate: e.candidate.candidate,
          sdpMid: e.candidate.sdpMid,
          sdpMLineIndex: e.candidate.sdpMLineIndex,
        },
      });
    });

    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.fallBack();
      // `disconnected` is often temporary, so it is not treated as failure
      // here; the channel closing is what actually moves us off direct.
    });

    if (this.isOfferer) {
      // Unordered and un-retransmitted on purpose: a position that arrives late
      // is worth less than the one behind it, and waiting for it would stall
      // everything newer.
      const channel = pc.createDataChannel("pos", { ordered: false, maxRetransmits: 0 });
      this.hold(channel);
      void this.offer(pc);
    } else {
      pc.addEventListener("datachannel", (e) => this.hold(e.channel));
    }

    // If nothing has connected by now, get on with it over the relay. A direct
    // connection may still arrive later and take over.
    this.timer = window.setTimeout(() => {
      if (this.state !== "direct") this.fallBack();
    }, CONNECT_TIMEOUT_MS);
  }

  private async offer(pc: RTCPeerConnection): Promise<void> {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.hooks.signal({ t: "rtc-offer", sdp: offer.sdp ?? "" });
    } catch {
      this.fallBack();
    }
  }

  private hold(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.addEventListener("open", () => {
      if (this.closed) return;
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      this.setCarrier("direct");
    });
    channel.addEventListener("close", () => this.fallBack());
    channel.addEventListener("error", () => this.fallBack());
    channel.addEventListener("message", (e) => {
      try {
        this.hooks.onStep(JSON.parse(String(e.data)) as Step);
      } catch {
        // A malformed frame is one lost position, not a reason to tear down.
      }
    });
  }

  /** Signalling that arrived over the relay. */
  async handleSignal(msg: ServerMessage): Promise<void> {
    if (this.closed) return;
    const pc = this.pc;
    if (!pc) return;
    try {
      if (msg.t === "rtc-offer" && !this.isOfferer) {
        await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
        this.remoteReady = true;
        await this.drainCandidates(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.hooks.signal({ t: "rtc-answer", sdp: answer.sdp ?? "" });
      } else if (msg.t === "rtc-answer" && this.isOfferer) {
        await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
        this.remoteReady = true;
        await this.drainCandidates(pc);
      } else if (msg.t === "rtc-ice") {
        // Candidates can outrun the description they belong to, so they wait.
        if (!this.remoteReady) this.pending.push(msg.candidate);
        else await pc.addIceCandidate(msg.candidate);
      }
    } catch {
      this.fallBack();
    }
  }

  private async drainCandidates(pc: RTCPeerConnection): Promise<void> {
    const held = this.pending;
    this.pending = [];
    for (const c of held) {
      try {
        await pc.addIceCandidate(c);
      } catch {
        // One unusable candidate does not sink the negotiation.
      }
    }
  }

  /** Route one step by whatever is currently working. */
  send(step: Step): void {
    if (this.closed) return;
    if (this.state === "direct" && this.channel?.readyState === "open") {
      try {
        this.channel.send(JSON.stringify(step));
        return;
      } catch {
        this.fallBack();
      }
    }
    this.hooks.viaRelay(step);
  }

  /** A step that came in over the relay rather than the channel. */
  receiveViaRelay(step: Step): void {
    this.hooks.onStep(step);
  }

  private fallBack(): void {
    if (this.closed || this.state === "relay") return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.setCarrier("relay");
  }

  private setCarrier(next: Carrier): void {
    if (this.state === next) return;
    this.state = next;
    this.hooks.onCarrier(next);
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.channel?.close();
      this.pc?.close();
    } catch {
      // Already torn down.
    }
    this.channel = null;
    this.pc = null;
    this.setCarrier("none");
  }
}
