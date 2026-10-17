// pnpm verifier:keys - on the Mac: creates the verifier's own key (never leaves this machine) and prints its public id.
// The verifier role needs no other secret: no wallet, no seed phrase, no other role's key.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@verdict/identity";
import { bytesToHex, createEd25519Signer, hexToBytes } from "@verdict/protocol";

const dir = dataDir();
const keys = join(dir, "keys");
mkdirSync(keys, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const file = join(keys, "verifier.key");
const created = !existsSync(file);
if (created) writeFileSync(file, bytesToHex(randomBytes(32)), { mode: 0o600 });
chmodSync(file, 0o600);
const seed = hexToBytes(readFileSync(file, "utf8").trim());
const { publicId } = await createEd25519Signer(seed);
console.log(
  `[verifier-keys] ${created ? "created" : "kept existing"} ${file} (0600, secret, never copy it)`,
);
console.log(`[verifier-keys] public id (send this to the Legion): ${publicId}`);
