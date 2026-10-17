// Process B: no Ed25519 secret, no WDK. Verifies with public id; opens sealed box with its own X25519 secret.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sodium from 'libsodium-wrappers'
import { dir } from './common.mjs'

await sodium.ready
const skFile = join(dir, 'b-verifier-x25519-sk.hex')
const pkFile = join(dir, 'b-verifier-x25519-pk.hex')
if (process.argv[2] === '--keygen') {
  const kp = sodium.crypto_box_keypair()
  writeFileSync(skFile, sodium.to_hex(kp.privateKey), { mode: 0o600 })
  writeFileSync(pkFile, sodium.to_hex(kp.publicKey))
  console.log('B keygen: verifier X25519 public key written')
  process.exit(0)
}
const o = JSON.parse(readFileSync(join(dir, 'b-out.json'), 'utf8'))
const pk = sodium.from_hex(o.public_id)
const sig = sodium.from_hex(o.signature)
const res = {
  ed25519_ok: sodium.crypto_sign_verify_detached(sig, o.message, pk),
  ed25519_tampered_message: sodium.crypto_sign_verify_detached(sig, o.message + 'x', pk),
}
const vpk = sodium.from_hex(readFileSync(pkFile, 'utf8').trim())
const vsk = sodium.from_hex(readFileSync(skFile, 'utf8').trim())
const opened = sodium.crypto_box_seal_open(sodium.from_hex(o.sealed_preimage), vpk, vsk)
res.sealed_open_hash_matches = createHash('sha256').update(opened).digest('hex') === o.preimage_sha256
try { // wrong key must fail
  const kp = sodium.crypto_box_keypair()
  sodium.crypto_box_seal_open(sodium.from_hex(o.sealed_preimage), kp.publicKey, kp.privateKey)
  res.sealed_wrong_key_rejected = false
} catch { res.sealed_wrong_key_rejected = true }
console.log('B verify (no signing secret):', JSON.stringify(res))
if (!res.ed25519_ok || res.ed25519_tampered_message || !res.sealed_open_hash_matches || !res.sealed_wrong_key_rejected) process.exit(1)
