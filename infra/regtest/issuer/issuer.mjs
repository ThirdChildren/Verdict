// Setup-only issuer: separate rgb-lib wallet (@utexo/rgb-sdk 1.0.3) issues tUSD and sends it to the buyer RLN node.
// Run under Node 22 (see .nvmrc). Not part of any workspace; never imported by a service.
// Env: RLN_COMPOSE_DIR (official regtest compose dir), ISSUER_BASE (shared/data dir parent).
import { WalletManager, generateKeys } from '@utexo/rgb-sdk'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
const BASE = process.env.ISSUER_BASE ?? '/tmp/claude-1000/rlnreg'
const REG = process.env.RLN_COMPOSE_DIR ?? `${BASE}/rln`, S = `${BASE}/shared`
const COMPOSE_OVERRIDE = process.env.COMPOSE_OVERRIDE ? `-f ${REG}/compose.yaml -f ${process.env.COMPOSE_OVERRIDE}` : ''
mkdirSync(S, { recursive: true, mode: 0o700 })
// ISSUER_MODE=seeds: only create the node seeds (if missing) and exit. Default: also issue tUSD and send it to the buyer.
// Stale hand-off files from an earlier partial run are removed so each issuing run starts clean.
const T0 = Date.now(); const log = (...a) => console.log(`[issuer +${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a)
const btc = (c) => execSync(`docker compose ${COMPOSE_OVERRIDE} exec -u blits bitcoind bitcoin-cli -regtest ${c} 2>/dev/null`, { cwd: REG, encoding: 'utf8' }).trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (const n of ['buyer','worker']) if (!existsSync(`${S}/${n}.seed`)) writeFileSync(`${S}/${n}.seed`, (await generateKeys('regtest')).mnemonic, { mode: 0o600 })  // fresh seeds per reset (reset wipes shared/): the proxy keys consignments by recipient_id
if (process.env.ISSUER_MODE === 'seeds') { log('seeds ready'); process.exit(0) }
for (const f of ['asset.json', 'invoice.txt', 'sent.flag', 'done.flag']) rmSync(`${S}/${f}`, { force: true })
const k = await generateKeys('regtest')
const w = new WalletManager({ xpubVan: k.accountXpubVanilla, xpubCol: k.accountXpubColored, masterFingerprint: k.masterFingerprint, mnemonic: k.mnemonic, network: 'regtest', transportEndpoint: 'rpc://localhost:3000/json-rpc', indexerUrl: 'tcp://localhost:50001', dataDir: `${BASE}/issuer-data` })
const reg = w.registerWallet(); log('registered', reg.address)
btc(`-rpcwallet=miner sendtoaddress ${reg.address} 1`); btc('-rpcwallet=miner -generate 1'); await sleep(2000)
w.syncWallet(); log('btc', JSON.stringify(w.getBtcBalance()))
log('createUtxos', await w.createUtxos({ upTo: false, num: 4, size: 32000, feeRate: 2 }))
btc('-rpcwallet=miner -generate 1'); await sleep(2000); w.syncWallet()
const a = w.issueAssetNia({ ticker: 'TUSD', name: 'tUSD', amounts: [100000], precision: 2 })
log('issued', JSON.stringify(a))
writeFileSync(`${S}/asset.json`, JSON.stringify(a))
while (!existsSync(`${S}/invoice.txt`)) await sleep(500)
const invoice = readFileSync(`${S}/invoice.txt`, 'utf8').trim()
log('sending to', invoice)
const r = await w.send({ invoice, assetId: a.assetId, amount: 60000, feeRate: 2 }); log('sent', JSON.stringify(r))
writeFileSync(`${S}/sent.flag`, '1')
while (!existsSync(`${S}/done.flag`)) { try { w.refreshWallet(); log('issuer balance', JSON.stringify(w.getAssetBalance(a.assetId))) } catch (e) { log('refresh err', String(e)) } await sleep(2000) }
log('done'); process.exit(0)
