// Generates the VAPID keypair the relay signs push requests with.
//
//   node tools/make-vapid.mjs
//
// The private key is a secret: put it in the worker with `wrangler secret put`
// and never commit it. The public key is not secret and has to be compiled
// into the client, since the browser needs it to create a subscription.
// Regenerating the pair invalidates every subscription made against the old one.

const pair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
);
const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

console.log("VAPID_PUBLIC_KEY  (goes in src/net/push.ts on the client, not secret)");
console.log("  " + b64url(pub));
console.log("");
console.log("VAPID_PRIVATE_KEY (secret: wrangler secret put VAPID_PRIVATE_KEY)");
console.log("  " + jwk.d);
console.log("");
console.log("Also set:  wrangler secret put VAPID_SUBJECT   (e.g. mailto:you@example.com)");
