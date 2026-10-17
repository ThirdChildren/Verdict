// Process B: no seed, no signer. Only message, signature, address.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WalletAccountReadOnlyEvm } from '@tetherto/wdk-wallet-evm'
import { verifyMessage } from 'ethers'
import { dir } from './common.mjs'

const { message, signature, address } = JSON.parse(readFileSync(join(dir, 'a-out.json'), 'utf8'))
const ro = new WalletAccountReadOnlyEvm(address, {})
const res = {
  wdk_readonly_ok: await ro.verify(message, signature),
  wdk_readonly_tampered_message: await ro.verify(message + 'x', signature).catch(() => false),
  wdk_readonly_wrong_address: await new WalletAccountReadOnlyEvm('0x000000000000000000000000000000000000dEaD', {}).verify(message, signature),
  ethers_only_ok: verifyMessage(message, signature).toLowerCase() === address.toLowerCase(),
}
console.log('A verify (no seed):', JSON.stringify(res))
if (!res.wdk_readonly_ok || res.wdk_readonly_tampered_message || res.wdk_readonly_wrong_address || !res.ethers_only_ok) process.exit(1)
