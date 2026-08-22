// Web Push, hand-rolled on WebCrypto because the usual libraries assume Node.
// Two specs meet here: RFC 8291 derives the content key from an ECDH between
// the server and the subscription, and RFC 8188 wraps the result in the
// aes128gcm content coding. `test/push.test.mjs` runs the worked example from
// RFC 8291 section 5 through it, so this is checked against the spec's own
// bytes rather than against itself.

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface VapidKeys {
  /** base64url, uncompressed P-256 point. */
  publicKey: string;
  /** base64url, the raw 32-byte scalar. */
  privateKey: string;
  /** Contact for the push service, a mailto: or https: URL. */
  subject: string;
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** An uncompressed P-256 point is 0x04 then the two 32-byte coordinates. */
function jwkFromPoint(point: Uint8Array, d?: Uint8Array): JsonWebKey {
  if (point.length !== 65 || point[0] !== 0x04) throw new Error("expected an uncompressed P-256 point");
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(point.subarray(1, 33)),
    y: b64urlEncode(point.subarray(33, 65)),
    ext: true,
  };
  if (d) jwk.d = b64urlEncode(d);
  return jwk;
}

/**
 * WebCrypto's HKDF does extract and expand together, which is exactly the
 * shape both specs want at every step here.
 */
async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  bytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Encrypt one message for one subscription. `senderKeys` and `salt` are
 * parameters only so the RFC's example can be reproduced; in use they are
 * freshly generated for every message, which is what the spec requires.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  subscriptionPublicKey: Uint8Array,
  authSecret: Uint8Array,
  senderKeys?: { publicKey: Uint8Array; privateKey: Uint8Array },
  fixedSalt?: Uint8Array,
): Promise<Uint8Array> {
  let asPublic: Uint8Array;
  let asPrivateKey: CryptoKey;
  if (senderKeys) {
    asPublic = senderKeys.publicKey;
    asPrivateKey = await crypto.subtle.importKey(
      "jwk", jwkFromPoint(senderKeys.publicKey, senderKeys.privateKey),
      { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"],
    );
  } else {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
    ) as CryptoKeyPair;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
    asPrivateKey = pair.privateKey;
  }

  const uaKey = await crypto.subtle.importKey(
    "raw", subscriptionPublicKey, { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  // workers-types spells the peer key `$public` to dodge the reserved word, but
  // the runtime wants `public`, so the value stays right and the type is cast.
  const ecdh = { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, asPrivateKey, 256));

  // RFC 8291 section 3.4: the receiver's key comes first in the info string.
  const keyInfo = concat(utf8("WebPush: info"), new Uint8Array([0]), subscriptionPublicKey, asPublic);
  const ikm = await hkdf(shared, authSecret, keyInfo, 32);

  const salt = fixedSalt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, concat(utf8("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hkdf(ikm, salt, concat(utf8("Content-Encoding: nonce"), new Uint8Array([0])), 12);

  // A single record, so it carries the 0x02 delimiter that marks the last one.
  const padded = concat(plaintext, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded),
  );

  // RFC 8188 header: salt, record size, key id length, then the key itself.
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, ciphertext);
}

/** The signed token that tells a push service who is asking. */
export async function vapidHeader(endpoint: string, keys: VapidKeys): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = { typ: "JWT", alg: "ES256" };
  // Twelve hours: comfortably inside the 24 the spec allows as a maximum.
  const body = { aud, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: keys.subject };
  const signingInput = [header, body]
    .map((o) => b64urlEncode(utf8(JSON.stringify(o))))
    .join(".");

  const pub = b64urlDecode(keys.publicKey);
  const priv = b64urlDecode(keys.privateKey);
  const signingKey = await crypto.subtle.importKey(
    "jwk", jwkFromPoint(pub, priv), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, signingKey, utf8(signingInput),
  ));
  return `vapid t=${signingInput}.${b64urlEncode(sig)}, k=${keys.publicKey}`;
}

export interface PushResult {
  ok: boolean;
  status: number;
  /** True when the push service says this subscription is dead for good. */
  gone: boolean;
}

/** Deliver one notification. A 404 or 410 means the subscription can be dropped. */
export async function sendPush(
  sub: PushSubscription,
  payload: unknown,
  keys: VapidKeys,
  ttlSeconds = 6 * 60 * 60,
): Promise<PushResult> {
  const body = await encryptPayload(
    utf8(JSON.stringify(payload)),
    b64urlDecode(sub.keys.p256dh),
    b64urlDecode(sub.keys.auth),
  );
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidHeader(sub.endpoint, keys),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttlSeconds),
      Urgency: "normal",
    },
    body,
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
