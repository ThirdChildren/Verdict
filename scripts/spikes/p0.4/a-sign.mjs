// Process A: holds the seed, derives a WDK EVM account, signs, writes public data only.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import { generateMnemonic } from 'bip39'
import { dir, message } from './common.mjs'

const seedFile = join(dir, 'a-seed.txt')
if (!existsSync(seedFile)) writeFileSync(seedFile, generateMnemonic(), { mode: 0o600 })
const wallet = new WalletManagerEvm(readFileSync(seedFile, 'utf8').trim(), {})
const account = await wallet.getAccount(0)
const signature = await account.sign(message)
const address = await account.getAddress()
writeFileSync(join(dir, 'a-out.json'), JSON.stringify({ message, signature, address }, null, 2))
console.log('A sign: address', address, 'sig', signature.slice(0, 20) + '…')
wallet.dispose?.()
