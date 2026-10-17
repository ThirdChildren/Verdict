#!/usr/bin/env bash
# Preflight: full reset (fresh seeds, channel through the wallet daemons), then one claim run and one cancel run
# over real regtest RGB-LN. Exit 0 only if everything is green. Usage: pnpm preflight
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
t0=$(date +%s)
say() { echo "[preflight] $*"; }
fail() { say "FAILED: $1"; exit 1; }
pnpm data:perms || fail "data dir or key/ledger file permissions (fix: pnpm data:perms -- --fix)"
pnpm --filter @verdict/worker bench || fail "worker bench: generation under 15 tok/s or peak VRAM over 15 GB"
pnpm demo:reset || fail "demo:reset"
[ -s "${VERDICT_DATA_DIR:-$HOME/.verdict-data}/network.json" ] || fail "network.json missing (pnpm regtest:setup writes it)"
say "reset ok in $(( $(date +%s) - t0 )) s; running claim + cancel"
pnpm exec vitest run --config tests/e2e/vitest.config.ts -t "run 1|run 2" || fail "claim/cancel e2e"
say "ALL GREEN in $(( $(date +%s) - t0 )) s"
