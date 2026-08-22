// Checks the push encryption against the worked example in RFC 8291 section 5.
// The sender keypair and salt are fixed there, so the output is fully
// determined: matching it byte for byte means the key derivation, the info
// strings and the record framing are all right.
//
//   node test/push.test.mjs
//
// Runs on plain Node: the implementation only uses WebCrypto and base64, both
// of which Node and workerd share.

// Node strips the types on import, so the worker's own module is what runs
// here rather than a copy of it.
import { encryptPayload, b64urlDecode, b64urlEncode } from "../src/push.ts";

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ""}`); }
};

// RFC 8291, section 5.
const VECTOR = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

console.log("web push encryption against RFC 8291 section 5\n");

const out = await encryptPayload(
  b64urlDecode(VECTOR.plaintext),
  b64urlDecode(VECTOR.uaPublic),
  b64urlDecode(VECTOR.auth),
  { publicKey: b64urlDecode(VECTOR.asPublic), privateKey: b64urlDecode(VECTOR.asPrivate) },
  b64urlDecode(VECTOR.salt),
);
const got = b64urlEncode(out);

check("the encrypted body matches the RFC byte for byte", got === VECTOR.body,
  got === VECTOR.body ? "" : `expected ${VECTOR.body}\n         got      ${got}`);

const expected = b64urlDecode(VECTOR.body);
check("the header carries the RFC's salt", b64urlEncode(out.subarray(0, 16)) === VECTOR.salt);
check("the record size is 4096", new DataView(out.buffer, out.byteOffset).getUint32(16) === 4096);
check("the key id length is 65", out[20] === 65);
check("the sender key is inlined in the header",
  b64urlEncode(out.subarray(21, 86)) === VECTOR.asPublic);
check("the body is the expected length", out.length === expected.length,
  `expected ${expected.length}, got ${out.length}`);

// A fresh call must not reuse the salt or the ephemeral key.
const a = await encryptPayload(b64urlDecode(VECTOR.plaintext), b64urlDecode(VECTOR.uaPublic), b64urlDecode(VECTOR.auth));
const b = await encryptPayload(b64urlDecode(VECTOR.plaintext), b64urlDecode(VECTOR.uaPublic), b64urlDecode(VECTOR.auth));
check("each message gets a fresh salt", b64urlEncode(a.subarray(0, 16)) !== b64urlEncode(b.subarray(0, 16)));
check("each message gets a fresh ephemeral key",
  b64urlEncode(a.subarray(21, 86)) !== b64urlEncode(b.subarray(21, 86)));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
