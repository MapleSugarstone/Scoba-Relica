// Sets the password on the published build. Takes the word, writes its hash
// into src/ui/gate.ts, and never writes the word itself anywhere.
//
//   node tools/set-password.mjs "the new password"
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, "src/ui/gate.ts");

function die(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const pass = process.argv.slice(2).join(" ").trim();
if (!pass) die('Give it a password: node tools/set-password.mjs "the new password"');

const source = readFileSync(target, "utf8");
// The salt is read from the game rather than repeated here, so the two cannot
// drift apart and lock everybody out.
const salt = source.match(/^const SALT = "(.*)";$/m);
if (!salt) die(`No SALT line in ${target}.`);
const line = /^const PASS_HASH = "[0-9a-f]*";$/m;
if (!line.test(source)) die(`No PASS_HASH line in ${target}.`);

const hash = createHash("sha256").update(salt[1] + pass, "utf8").digest("hex");
writeFileSync(target, source.replace(line, `const PASS_HASH = "${hash}";`), "utf8");

console.log(`\n  Password set. ${target}`);
console.log("  Commit and push, and the site asks for it on the next visit.");
console.log("  Anyone already let in stays in until they clear the site's storage.\n");
