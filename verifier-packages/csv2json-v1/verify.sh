#!/bin/sh
# Usage: verify.sh <delivery_dir>. Local self-check: executor, then judge. Prints one JSON line per check; exit 0 only if all pass.
# The verifier service does NOT use this script: it sandboxes the executor step and runs verify.mjs outside the sandbox.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[ $# -eq 1 ] || { echo '{"id":"usage","status":"fail"}'; exit 2; }
out=$(mktemp -d) || exit 2
trap 'rm -rf "$out"' EXIT
node "$here/execute.mjs" "$1" "$out"
node "$here/verify.mjs" "$1" "$out"
