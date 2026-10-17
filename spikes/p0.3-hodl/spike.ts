import WalletManagerRgbLightning from '@utexo/wdk-rgb-lightning'
import { createHash, randomBytes } from 'node:crypto'
import { execSync } from 'node:child_process'
import { rmSync, mkdirSync } from 'node:fs'

const REG = '/tmp/claude-1000/rlnreg/rln'
const DATA = '/tmp/claude-1000/rlnreg/data'
const T0 = Date.now()
const log = (...a: unknown[]) => console.log(`[+${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sh = (c: string) => execSync(c, { cwd: REG, encoding: 'utf8' }).trim()
const btc = (c: string) => sh(`docker compose exec -u blits bitcoind bitcoin-cli -regtest ${c} 2>/dev/null`)
const mine = (n: number) => btc(`-rpcwallet=miner -generate ${n}`)

rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true })
import { existsSync as ex0, readFileSync as rf0 } from 'node:fs'
const SHD = '/tmp/claude-1000/rlnreg/shared'
while (!ex0(`${SHD}/worker.seed`)) await new Promise((r) => setTimeout(r, 300))
await new Promise((r) => setTimeout(r, 300))
const SEEDS = { buyer: rf0(`${SHD}/buyer.seed`, 'utf8').trim(), worker: rf0(`${SHD}/worker.seed`, 'utf8').trim() }
const PORTS = { buyer: 9801, worker: 9802 }
const unlockReq = (alias: string) => ({
  bitcoind_rpc_username: 'user', bitcoind_rpc_password: 'password', bitcoind_rpc_host: '127.0.0.1', bitcoind_rpc_port: 18443,
  indexer_url: 'tcp://localhost:50001', proxy_endpoint: 'rpc://localhost:3000/json-rpc', announce_addresses: [], announce_alias: alias,
})
async function mk(name: 'buyer' | 'worker') {
  const m = new WalletManagerRgbLightning(SEEDS[name], { network: 'regtest', dataDir: `${DATA}/${name}`, ldkPeerListeningPort: PORTS[name], daemonListeningPort: 0 } as never)
  const a = await m.getAccount(0)
  await a.unlock(unlockReq(name))
  return { m, a }
}
const j = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
const step = async <T>(label: string, f: () => Promise<T>): Promise<T> => {
  const t = Date.now()
  try { const r = await f(); log(label, `(${Date.now() - t}ms)`, j(r)?.slice(0, 600)); return r } catch (e) { log(label, 'THREW', String(e)); throw e }
}

const B = await mk('buyer'); const W = await mk('worker')
log('unlocked both')
const buyer = B.a, worker = W.a
if (process.env.PROBE) {  // probe which minFinalCltvExpiryDelta values createHodlInvoice accepts (plain BTC invoice, no channel needed)
  for (const d of [0, 1, 10, 17, 18, 19, 20, 30, 35, 36, 37, 38, 39, 40, 41, 42]) {
    try { const i: any = await W.a.createHodlInvoice({ paymentHash: createHash('sha256').update(randomBytes(32)).digest('hex'), amtMsat: 3_000_000, expirySec: 3600, minFinalCltvExpiryDelta: d }); log('PROBE', d, 'ACCEPTED', (await W.a.decodeInvoice(i.bolt11) as any).min_final_cltv_expiry_delta) } catch (e) { log('PROBE', d, 'REJECTED', String(e).slice(0, 160)) }
  }
  process.exit(0)
}
const bInfo: any = await step('buyer nodeInfo', () => buyer.getNodeInfo())
const wInfo: any = await step('worker nodeInfo', () => worker.getNodeInfo())
for (const [n, a] of [['buyer', buyer], ['worker', worker]] as const) {
  const addr = await a.getAddress()
  btc(`-rpcwallet=miner sendtoaddress ${addr} 1`)
  log('funded', n, addr)
}
mine(1)
await sleep(3000)
await step('buyer btc', () => buyer.getBalanceDetails())
for (const a of [buyer, worker]) await a.createUtxos({ up_to: false, num: 4, size: 32000, fee_rate: 2, skip_sync: false })
mine(1); await sleep(2000)
await step('buyer sync', () => buyer.sync()); await step('worker sync', () => worker.sync())
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const SH = '/tmp/claude-1000/rlnreg/shared'
while (!existsSync(`${SH}/asset.json`)) await sleep(500)
const assetId: string = JSON.parse(readFileSync(`${SH}/asset.json`, 'utf8')).assetId
const rinv: any = await step('buyer createRgbInvoice', () => buyer.createRgbInvoice({ min_confirmations: 1, witness: false, duration_seconds: 3600 }))
writeFileSync(`${SH}/invoice.txt`, rinv.invoice)
while (!existsSync(`${SH}/sent.flag`)) await sleep(500)
for (let i = 0; i < 25; i++) { await buyer.refreshTransfers({ skip_sync: false }); const bb: any = await buyer.getAssetBalance(assetId); log('buyer asset bal', j(bb)); if (bb.settled >= 60000) break; mine(1); await sleep(2500) }
writeFileSync(`${SH}/done.flag`, '1')
log('assetId', assetId)
await step('connect', () => buyer.connectPeer(`${wInfo.pubkey}@127.0.0.1:${PORTS.worker}`))
await step('openChannel', () => buyer.openChannel({
  peer_pubkey_and_opt_addr: `${wInfo.pubkey}@127.0.0.1:${PORTS.worker}`, capacity_sat: 100000, push_msat: 0,
  asset_id: assetId, asset_amount: 50000, public: false, with_anchors: true,
}))
mine(6)
for (let i = 0; i < 30; i++) {
  mine(1); await sleep(2500)
  const ch: any = await buyer.listChannels()
  const c = (ch.channels ?? ch)[0]
  if (c) log('chan', c.status, c.ready, c.is_usable, 'w:', ((await worker.listChannels()) as any)[0]?.status)
  if (c?.ready) break
}
await step('buyer listChannels', () => buyer.listChannels())
const bal = async (n: string, a: typeof buyer) => log('balance', n, j(await a.getAssetBalance(assetId)))
await bal('buyer', buyer); await bal('worker', worker)

const height = () => Number(btc('getblockcount'))
const AMT = Number(process.env.AMT_MSAT ?? 3_000_000)
const ASSET_AMT = 1000
const EXPIRY = Number(process.env.EXPIRY_SEC ?? 3600)
const CLTV = process.env.CLTV ? Number(process.env.CLTV) : undefined
const ONLY_B = process.env.ONLY_B === '1'
const NO_MINE_B = process.env.NO_MINE_B === '1'  // case B: wait on wall clock instead of mining
async function hodl(tag: string, claim: boolean, amt = AMT) {
  const preimage = randomBytes(32)
  const paymentHash = createHash('sha256').update(preimage).digest('hex')
  const inv = await step(`${tag} createHodlInvoice`, () => worker.createHodlInvoice({ paymentHash, assetId, assetAmount: ASSET_AMT, amtMsat: amt, expirySec: EXPIRY, ...(CLTV !== undefined ? { minFinalCltvExpiryDelta: CLTV } : {}) }))
  log(tag, 'worker invoice status', j(await worker.getInvoiceStatus(inv.bolt11)))
  log(tag, 'decode', j(await worker.decodeInvoice(inv.bolt11)))
  let payRes: any
  const pt = Date.now()
  try { payRes = await step(`${tag} sendPayment`, () => buyer.sendPayment({ invoice: inv.bolt11 })) } catch (e) { log(tag, 'pay threw', String(e)); return { inv, paymentHash, preimage } }
  // poll
  const seen = new Set<string>()
  for (let i = 0; i < 40; i++) {
    const ws = (await worker.getInvoiceStatus(inv.bolt11) as any).status
    const bs = ((await buyer.getPayment(paymentHash, 'Outbound' as never)) as any)
    const s = `worker=${ws} buyer=${bs.status}`
    if (!seen.has(s)) { seen.add(s); log(tag, `+${Date.now() - pt}ms`, s) }
    if (ws === 'Claimable') break
    await sleep(500)
  }
  await bal('buyer(held)', buyer); await bal('worker(held)', worker)
  return { inv, paymentHash, preimage }
}

// case a
if (!ONLY_B) {
const a = await hodl('A', true)
await step('A claim', () => worker.claimHodlInvoice({ payment_hash: a.paymentHash, payment_preimage: a.preimage.toString('hex') }))
const ta = Date.now(); const seenA = new Set<string>()
for (let i = 0; i < 40; i++) {
  const ws = (await worker.getInvoiceStatus(a.inv.bolt11) as any).status
  const bp: any = await buyer.getPayment(a.paymentHash, 'Outbound' as never)
  const s = `worker=${ws} buyer=${bp.status}`
  if (!seenA.has(s)) { seenA.add(s); log('A after claim', `+${Date.now() - ta}ms`, s) }
  if (ws === 'Succeeded' && bp.status === 'Succeeded') break
  await sleep(500)
}
log('A buyer payment', j(await buyer.getPayment(a.paymentHash, 'Outbound' as never)))
log('A buyer listPayments', j(await buyer.listPayments()).slice(0,800))
log('A worker payment', j(await worker.getPayment(a.paymentHash, 'InboundHodl' as never)))
await bal('buyer', buyer); await bal('worker', worker)

// min amount probes + cancel (case C)
for (const amt of [1_000_000, 2_999_999]) {
  try {
    const m = await hodl(`MIN${amt}`, false, amt)
    const ws = (await worker.getInvoiceStatus(m.inv.bolt11) as any).status
    const bp: any = await buyer.getPayment(m.paymentHash, 'Outbound' as never)
    log(`MIN${amt} result worker=${ws} buyer=${bp.status} fc=${bp.failure_code}`)
    try { await worker.cancelHodlInvoice({ payment_hash: m.paymentHash }) } catch (e) { log('cancel threw', String(e)) }
  } catch (e) { log(`MIN${amt} threw`, String(e).slice(0, 200)) }
}
{
  const c = await hodl('C', false)
  const tc = Date.now()
  log('C cancel', j(await worker.cancelHodlInvoice({ payment_hash: c.paymentHash })))
  const seenC = new Set<string>()
  for (let i = 0; i < 40; i++) {
    const bp: any = await buyer.getPayment(c.paymentHash, 'Outbound' as never)
    const ws = (await worker.getInvoiceStatus(c.inv.bolt11) as any).status
    const s = `worker=${ws} buyer=${bp.status} fc=${bp.failure_code ?? ''}`
    if (!seenC.has(s)) { seenC.add(s); log('C after cancel', `+${Date.now() - tc}ms`, s) }
    if (bp.status === 'Failed' || bp.status === 'Cancelled') break
    await sleep(500)
  }
  await bal('buyer', buyer); await bal('worker', worker)
}
}
// case b
const b = await hodl('B', false)
const hSend = height(); log('B sent at height', hSend)
const tb = Date.now(); let blocks = 0; const seenB = new Set<string>()
for (let i = 0; i < (NO_MINE_B ? 60 : 220); i++) {
  const bp: any = await buyer.getPayment(b.paymentHash, 'Outbound' as never)
  const ws = (await worker.getInvoiceStatus(b.inv.bolt11) as any).status
  const s = `worker=${ws} buyer=${bp.status} fc=${bp.failure_code ?? ''}`
  if (!seenB.has(s)) { seenB.add(s); log('B', `blocks=${blocks} height=${height()} +${Date.now() - tb}ms`, s) }
  if (bp.status === 'Failed' || bp.status === 'Cancelled') { log('B payment final', j(bp)); break }
  if (!NO_MINE_B || (i === 25 && process.env.MINE_ONE_AT_25)) mine(1); blocks++
  await sleep(NO_MINE_B ? 1000 : 400)
}
await sleep(3000)
await bal('buyer', buyer); await bal('worker', worker)
log('B total blocks mined', blocks)
try { log('B worker cancel/after', j(await worker.getInvoiceStatus(b.inv.bolt11))) } catch {}
await B.m.dispose(); await W.m.dispose()
log('done'); process.exit(0)
