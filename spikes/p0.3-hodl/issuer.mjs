// Thin wrapper: the issuer lives in infra/regtest/issuer (Node 22, own deps). Run: node issuer.mjs (under Node 22)
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const dir = fileURLToPath(new URL('../../infra/regtest/issuer/', import.meta.url))
spawn(process.execPath, ['issuer.mjs'], { cwd: dir, stdio: 'inherit' }).on('exit', (c) => process.exit(c ?? 1))
