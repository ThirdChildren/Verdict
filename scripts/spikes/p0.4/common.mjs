import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import canonicalize from 'canonicalize'

export const dir = join(process.env.VERDICT_DATA_DIR ?? join(homedir(), '.verdict-data'), 'spike-p0.4')
mkdirSync(dir, { recursive: true, mode: 0o700 })

const body = { amount: '1.20', asset: 'tUSD', task: 'csv2json', n: 1 }
export const message = `verdict:v0:TEST:${createHash('sha256').update(canonicalize(body)).digest('hex')}`
