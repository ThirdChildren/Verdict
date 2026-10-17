#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node a-sign.mjs && node a-verify.mjs
node b-verify.mjs --keygen && node b-sign.mjs && node b-verify.mjs
