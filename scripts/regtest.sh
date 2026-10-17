#!/usr/bin/env bash
# Regtest stack for Verdict: official RGB-Tools/rgb-lightning-node compose (bitcoind, electrs, esplora, rgb-proxy).
# Usage: regtest.sh up | down | reset | mine <n> | status | setup
# Env: VERDICT_DATA_DIR (default ~/.verdict-data), RLN_COMPOSE_DIR (default $VERDICT_DATA_DIR/regtest/rln, cloned if missing).
# Idempotent. Works with Docker or Podman (podman-docker): the Podman uid/SELinux fix is applied automatically.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${VERDICT_DATA_DIR:-$HOME/.verdict-data}"
RGN="$DATA/regtest"
RLN="${RLN_COMPOSE_DIR:-$RGN/rln}"
OVERRIDE="$ROOT/infra/regtest/compose.override.yaml"
say() { echo "[regtest] $*"; }
is_podman() { docker --version 2>/dev/null | grep -qi podman || docker info 2>/dev/null | grep -qi podman; }
dc() { (cd "$RLN" && docker compose -f compose.yaml -f "$OVERRIDE" "$@"); }
btc() { dc exec -T -u blits bitcoind bitcoin-cli -regtest "$@"; }
ensure_clone() {
  if [ ! -f "$RLN/compose.yaml" ]; then
    say "cloning RGB-Tools/rgb-lightning-node into $RLN (no HODL needed here: only its compose file is used)"
    mkdir -p "$(dirname "$RLN")"
    git clone --depth 1 https://github.com/RGB-Tools/rgb-lightning-node "$RLN"
  fi
}
data_dirs() {
  (cd "$RLN" && mkdir -p datacore dataindex dataesplora)
  if is_podman; then (cd "$RLN" && podman unshare chown -R 1000:1000 datacore dataindex dataesplora); fi
}
wait_for() { # name, command...
  local name="$1"; shift
  for _ in $(seq 1 90); do if "$@" >/dev/null 2>&1; then say "$name ready"; return 0; fi; sleep 1; done
  say "TIMEOUT waiting for $name"; return 1
}
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

cmd_up() {
  ensure_clone
  data_dirs
  dc up -d bitcoind
  wait_for bitcoind btc getblockcount
  btc createwallet miner >/dev/null 2>&1 || btc loadwallet miner >/dev/null 2>&1 || true
  local h; h="$(btc getblockcount)"
  if [ "$h" -lt 103 ]; then btc -rpcwallet=miner -generate $((103 - h)) >/dev/null; say "mined up to 103 blocks"; fi
  dc up -d
  wait_for "rgb-proxy :3000" port_open 3000
  wait_for "electrs :50001" port_open 50001
  say "stack up, height $(btc getblockcount)"
}
cmd_down() { [ -f "$RLN/compose.yaml" ] && dc down --remove-orphans || true; say "stack down (chain data kept)"; }
cmd_reset() {
  [ -f "$RLN/compose.yaml" ] && dc down -v --remove-orphans || true
  if [ -d "$RLN" ]; then
    if is_podman; then (cd "$RLN" && podman unshare rm -rf datacore dataindex dataesplora); else (cd "$RLN" && rm -rf datacore dataindex dataesplora); fi
  fi
  # RGB assets live in the node data dirs, and the proxy rejects re-used seeds: wipe nodes and seeds with the chain.
  rm -rf "$RGN/nodes" "$RGN/shared"
  say "wiped chain, node data dirs and seeds"
  cmd_up
  say "reset done; run: pnpm regtest:setup"
}
cmd_mine() {
  [ "${1:-}" = "--" ] && shift
  local n="${1:-1}"
  [[ "$n" =~ ^[0-9]+$ ]] || { say "usage: mine <n>"; exit 2; }
  btc -rpcwallet=miner -generate "$n" >/dev/null
  say "mined $n block(s), height $(btc getblockcount)"
}
cmd_status() { say "height $(btc getblockcount 2>/dev/null || echo down)"; dc ps 2>/dev/null | tail -n +2 || true; }
cmd_setup() { # phases seeds|fund|tusd|channel (see infra/regtest/setup.ts); usage: setup [--step <name>]
  [ "${1:-}" = "--" ] && shift
  RLN_COMPOSE_DIR="$RLN" VERDICT_DATA_DIR="$DATA" exec pnpm exec tsx "$ROOT/infra/regtest/setup.ts" "$@"
}

case "${1:-}" in
  up) cmd_up ;; down) cmd_down ;; reset) cmd_reset ;; mine) shift; cmd_mine "${@}" ;;
  status) cmd_status ;; setup) shift; cmd_setup "$@" ;;
  *) echo "usage: regtest.sh up|down|reset|mine <n>|status|setup [--step name]" >&2; exit 2 ;;
esac
