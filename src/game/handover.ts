/**
 * Swapping the stand-in for the player it stands in for.
 *
 * While nobody is playing the other character, this client walks them itself.
 * The moment somebody logs in, where that character is stops being this
 * client's business, and the two answers rarely agree: the stand-in is beside
 * you and the real one is wherever they left off. Putting the character
 * straight there reads as them blinking out.
 *
 * So the stand-in walks. It heads for where the returning player really is,
 * and hands over once it gets there, which is a meeting rather than a jump.
 * Follow it and you see that happen. Stay where you are and it walks off the
 * screen and the swap is made out of sight, which is the same thing from your
 * side. A player on another map cannot be met at all, so it walks off the
 * screen instead and goes that way.
 *
 * The scene owns the walking. This owns only the question of what the walk
 * should be doing, which is the part worth testing.
 */

/** How near the stand-in has to get before the real player takes over. */
export const MEET_DIST = 18;
/** How long a walk is given before it fades out wherever it has got to. */
export const HANDOVER_MAX = 25;
/** How long it waits to hear where the returning player is before giving up. */
export const HANDOVER_WAIT = 6;

export interface HandoverSense {
  /** Where the returning player is, or null until their first position lands. */
  peer: { x: number; y: number } | null;
  /** Whether that position is on the map being drawn. */
  sameMap: boolean;
  /** How far the stand-in is from them. */
  dist: number;
  /** Whether the stand-in has walked past the edge of what the camera shows. */
  offView: boolean;
  /** Whether a fade already asked for has finished. */
  faded: boolean;
}

/** What the scene should do with the stand-in this frame. */
export type HandoverAct =
  /** Nothing heard yet: leave it following, as though nothing had happened. */
  | "follow"
  /** Walk it over to where they are. */
  | "meet"
  /** They are on another map: walk it off the screen. */
  | "leave"
  /** Out of sight or out of time: take it down. */
  | "fade"
  /** The swap is made; the real player has the character from here. */
  | "done";

export class Handover {
  private t = 0;
  /** Set once their position has actually arrived. */
  private heard = false;
  private fading = false;

  /** Advance a frame and say what the stand-in should be doing. */
  step(dt: number, s: HandoverSense): HandoverAct {
    this.t += dt;
    // Once it is going, it goes. A player who walks up mid-fade is met on the
    // other side of it, which is a moment later and out of sight either way.
    if (this.fading) return s.faded ? "done" : "fade";
    if (!s.peer) {
      // Silence before the first word is a connection still settling. After
      // it, they have gone again, and the stand-in simply stays on.
      return this.heard || this.t >= HANDOVER_WAIT ? "done" : "follow";
    }
    this.heard = true;
    if (s.sameMap && s.dist <= MEET_DIST) return "done";
    // Off the screen is the whole point: nobody sees the swap. Out of time
    // covers a walk that cannot finish, which is a player following the
    // stand-in toward somewhere it can never reach.
    if (s.offView || this.t >= HANDOVER_MAX) {
      this.fading = true;
      return "fade";
    }
    return s.sameMap ? "meet" : "leave";
  }
}
