// Generates the VAPID keypair the relay signs push requests with.
//
//   node tools/make-vapid.mjs
//
// This file holds no keys, it makes them, so it is safe to commit. Its output
// is not: the private key belongs in `wrangler secret put` and nowhere else.
// Name any `--out` file `vapid-something.txt` so the repo's ignore rules catch
// it. The public key is not secret and is compiled into the client, since the
// browser needs it to create a subscription. Regenerating the pair invalidates
// every subscription made against the old one.

const pair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
);
const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const publicKey = b64url(pub);
const privateKey = jwk.d;

// `--out <file>` keeps the private half off stdout entirely, so the generator
// can be run by something that should not see it. Without it both are printed,
// which is what you want when you are running this yourself.
const outAt = process.argv.indexOf("--out");
const outFile = outAt >= 0 ? process.argv[outAt + 1] : null;

if (outFile) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outFile, [
    "Scoba Relica VAPID keypair",
    "",
    "Paste each of these into the matching prompt from:",
    "  npx wrangler secret put VAPID_PUBLIC_KEY",
    "  npx wrangler secret put VAPID_PRIVATE_KEY",
    "  npx wrangler secret put VAPID_SUBJECT",
    "",
    "VAPID_PUBLIC_KEY (not secret; also goes in the client build)",
    publicKey,
    "",
    "VAPID_PRIVATE_KEY (SECRET: never commit, never paste into a chat)",
    privateKey,
    "",
    "VAPID_SUBJECT is a contact URL you choose, e.g. mailto:you@example.com",
    "",
    "Delete this file once the three secrets are set.",
    "",
  ].join("\n"), "utf8");
  // Only the public half reaches stdout.
  console.log(publicKey);
} else {
  console.log("VAPID_PUBLIC_KEY  (goes in the client build, not secret)");
  console.log("  " + publicKey);
  console.log("");
  console.log("VAPID_PRIVATE_KEY (secret: wrangler secret put VAPID_PRIVATE_KEY)");
  console.log("  " + privateKey);
  console.log("");
  console.log("Also set:  wrangler secret put VAPID_SUBJECT   (e.g. mailto:you@example.com)");
}
