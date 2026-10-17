#!/usr/bin/env bash
# Verdict doctor. Checks only; installs and creates nothing. Exit 1 if any check fails.
# Roles: verifier (Mac or any machine running only the verifier), legion (full stack).
set -u

usage() {
  cat <<'USAGE'
Usage: bash scripts/doctor.sh [--role verifier|legion] [--help]

Roles:
  verifier  Node 24, pnpm 12.10.1, git, free disk, sandbox (sandbox-exec on macOS; bwrap + prlimit on
            Linux), VERDICT_DATA_DIR permissions. Default on macOS.
  legion    Everything above plus Rust, docker compose, regtest, NVIDIA/Vulkan, QVAC model cache,
            Node 22 for the issuer, issuer node_modules. Default on Linux.
USAGE
}

OS=$(uname -s)
if [ "$OS" = Darwin ]; then ROLE=verifier; else ROLE=legion; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --role) ROLE="${2:-}"; shift 2 ;;
    --role=*) ROLE="${1#--role=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
case "$ROLE" in verifier|legion) ;; *) echo "unknown role: $ROLE" >&2; usage >&2; exit 2 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Make tools visible from any shell (non-login, CI, script runners). All optional.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
FNM_DIR="${FNM_PATH:-$HOME/.local/share/fnm}"
[ -x "$FNM_DIR/fnm" ] && export PATH="$FNM_DIR:$PATH"
command -v fnm >/dev/null 2>&1 && eval "$(fnm env --shell bash)" 2>/dev/null
if ! command -v node >/dev/null 2>&1 && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1
  nvm use 24 >/dev/null 2>&1 || nvm use default >/dev/null 2>&1
fi

DATA_DIR="${VERDICT_DATA_DIR:-$HOME/.verdict-data}"
if [ "$ROLE" = legion ]; then MIN_FREE_GB="${MIN_FREE_GB:-30}"; else MIN_FREE_GB="${MIN_FREE_GB:-2}"; fi
BITCOIND_PORT="${BITCOIND_PORT:-18443}"
ELECTRS_PORT="${ELECTRS_PORT:-50001}"
PROXY_PORT="${RGB_PROXY_PORT:-3000}"
QVAC_DIR="${QVAC_CACHE_DIR:-$HOME/.qvac}"

FAIL=0
ROWS=()
row() { # status name detail fix
  local s="$1"
  [ "$s" = FAIL ] && FAIL=1
  ROWS+=("$s|$2|$3|${4:-}")
}
have() { command -v "$1" >/dev/null 2>&1; }
listening() {
  if have ss; then ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"
  elif have lsof; then lsof -iTCP:"$1" -sTCP:LISTEN -P -n >/dev/null 2>&1
  else return 1; fi
}
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null; }

# Node 24 (nvm, fnm or plain PATH)
if have node; then
  v=$(node -v); [[ $v == v24.* ]] && row PASS "node 24 LTS" "$v ($(command -v node))" || row FAIL "node 24 LTS" "found $v" "nvm install 24 && nvm use 24   (or: fnm install 24 && fnm default 24)"
else row FAIL "node 24 LTS" "not found" "install Node 24 (nvm install 24, or fnm install 24)"; fi

# pnpm 12.10.1 (corepack or direct). No pnpm command is run through the repo; only the version.
if have pnpm; then
  pv=$(pnpm -v 2>/dev/null | tail -n1)
  src="direct"; p=$(command -v pnpm); rp=$(readlink "$p" 2>/dev/null || true)
  [[ $p == *corepack* || $rp == *corepack* ]] && src="corepack"
  if [ -z "$pv" ]; then row FAIL "pnpm 12.10.1" "does not run" "corepack enable"
  elif [ "$pv" = "12.10.1" ]; then row PASS "pnpm 12.10.1" "$pv ($src)"
  else row FAIL "pnpm 12.10.1" "found $pv ($src)" "corepack enable && corepack prepare pnpm@12.10.1 --activate"; fi
else row FAIL "pnpm 12.10.1" "not found" "corepack enable && corepack prepare pnpm@12.10.1 --activate"; fi

# git
have git && row PASS "git" "$(git --version)" || row FAIL "git" "not found" "install git (xcode-select --install / dnf install git)"

# disk (portable df -k)
target="$DATA_DIR"; [ -d "$target" ] || target="$HOME"
free_kb=$(df -k "$target" 2>/dev/null | awk 'NR==2{print $4}')
free=$(( ${free_kb:-0} / 1024 / 1024 ))
if [ "$free" -ge "$MIN_FREE_GB" ]; then row PASS "free disk" "${free} GB on $target"
else row FAIL "free disk" "${free} GB < ${MIN_FREE_GB} GB on $target" "free space, or set VERDICT_DATA_DIR / MIN_FREE_GB"; fi

# data dir permissions (check only, never create)
if [ -d "$DATA_DIR" ]; then
  m=$(mode_of "$DATA_DIR")
  [ "$m" = 700 ] && row PASS "data dir mode" "$DATA_DIR is 0700" || row FAIL "data dir mode" "$DATA_DIR is 0${m:-?}, want 0700" "chmod 700 $DATA_DIR"
else
  row PASS "data dir mode" "$DATA_DIR not created yet (services create it 0700)"
fi

# sandbox
if [ "$OS" = Darwin ]; then
  if have sandbox-exec && sandbox-exec -p '(version 1)(allow default)(deny network*)' /usr/bin/true >/dev/null 2>&1; then
    row PASS "sandbox-exec" "works (network deny profile)"
  else row FAIL "sandbox-exec" "missing or refused to run" "sandbox-exec ships with macOS; check /usr/bin/sandbox-exec and that this shell is not already sandboxed"; fi
else
  if have bwrap && bwrap --ro-bind / / --unshare-net /bin/true >/dev/null 2>&1; then row PASS "bwrap" "works (unshare-net)"
  elif have bwrap; then row FAIL "bwrap" "installed but cannot unshare net" "enable unprivileged user namespaces (sysctl kernel.unprivileged_userns_clone=1)"
  else row FAIL "bwrap" "not found" "sudo dnf install -y bubblewrap   # or apt install bubblewrap"; fi
  have prlimit && row PASS "prlimit" "$(prlimit --version 2>&1 | head -n1)" || row FAIL "prlimit" "not found" "install util-linux"
fi

if [ "$ROLE" = legion ]; then
  # fnm is optional; Node can come from nvm or PATH
  have fnm && row PASS "fnm" "$(fnm --version)" || row SKIP "fnm" "not installed (optional)" ""

  # rust
  if have rustup && have cargo; then
    if rustup toolchain list 2>/dev/null | grep -q '^1\.88\.0'; then row PASS "rustup + cargo" "$(cargo --version | cut -d' ' -f1-2), 1.88.0 installed"
    else row FAIL "rustup + cargo" "toolchain 1.88.0 missing" "rustup toolchain install 1.88.0 --profile minimal"; fi
  else row FAIL "rustup + cargo" "not found" "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal; exec \$SHELL; rustup toolchain install 1.88.0 --profile minimal"; fi

  # docker compose (Docker or Podman)
  if have docker; then
    dv=$(docker --version 2>&1 | head -n1)
    craw=$(docker compose version 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
    cv=$(echo "$craw" | grep -i 'version' | grep -vi 'executing' | head -n1)
    cprov=$(echo "$craw" | grep -i 'executing' | grep -o '"[^"]*"' | head -n1)
    echo "docker --version:         $dv"
    echo "docker compose version:   $cv"
    echo "backend: $( [[ $dv == *odman* ]] && echo Podman || echo Docker ); compose provider: ${cprov:-built-in plugin}"
    echo
    if docker compose version >/dev/null 2>&1; then row PASS "docker compose" "$cv"
    else row FAIL "docker compose" "not working" "Podman: sudo dnf install -y podman-docker docker-compose ; Docker: sudo dnf install -y docker-compose-plugin"; fi
    if [[ $dv == *odman* ]] || docker --version 2>&1 | grep -qi podman || docker info 2>/dev/null | grep -qi podman; then
      row PASS "docker group" "skipped (Podman)"
      [ -n "${DOCKER_HOST:-}" ] && row PASS "DOCKER_HOST" "$DOCKER_HOST" || row FAIL "DOCKER_HOST" "unset (needed for Podman)" "systemctl --user enable --now podman.socket; echo 'export DOCKER_HOST=unix://\$XDG_RUNTIME_DIR/podman/podman.sock' >> ~/.bashrc && exec \$SHELL"
    else
      id -nG | tr ' ' '\n' | grep -qx docker && row PASS "docker group" "$USER is a member" || row FAIL "docker group" "$USER not in docker group" "sudo usermod -aG docker \$USER  # then log out and back in"
    fi
  else
    echo "docker: not found"; echo
    row FAIL "docker compose" "docker not installed" "Podman: sudo dnf install -y podman-docker docker-compose"
  fi

  # regtest state / port 3000
  if listening "$BITCOIND_PORT"; then REGTEST=up; else REGTEST=down; fi
  if [ "$REGTEST" = down ]; then
    if listening "$PROXY_PORT"; then
      row FAIL "port $PROXY_PORT free" "in use while regtest is down" "find the owner: lsof -iTCP:$PROXY_PORT -sTCP:LISTEN -P -n ; stop another regtest (pnpm regtest:down)"
    else row PASS "port $PROXY_PORT free" "free (regtest down)"; fi
  else
    row PASS "regtest state" "up (bitcoind :$BITCOIND_PORT listening)"
  fi

  # NVIDIA driver
  if have nvidia-smi && nvidia-smi -L >/dev/null 2>&1; then
    g=$(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader | head -n1)
    row PASS "NVIDIA driver" "$g"
  else row FAIL "NVIDIA driver" "nvidia-smi missing or failing" "sudo dnf install -y akmod-nvidia xorg-x11-drv-nvidia-cuda  # wait ~5 min, reboot, enroll MOK if Secure Boot"; fi

  # Vulkan (any NVIDIA GPU)
  if have vulkaninfo; then
    vs=$(vulkaninfo --summary 2>/dev/null)
    nv=$(echo "$vs" | grep -i 'deviceName' | grep -i nvidia | head -n1 | sed 's/^ *//; s/  */ /g')
    if [ -n "$nv" ]; then row PASS "vulkan NVIDIA GPU" "$nv"
    else row FAIL "vulkan NVIDIA GPU" "GPUs: $(echo "$vs" | grep -i deviceName | sed 's/^ *//; s/  */ /g' | paste -sd, -)" "sudo dnf install -y vulkan-tools; check NVIDIA driver loaded (nvidia-smi), reboot"; fi
  else row FAIL "vulkan NVIDIA GPU" "vulkaninfo not found" "sudo dnf install -y vulkan-tools"; fi

  # QVAC model cache. Exact file names are not verified (SDK_NOTES: cache is ~/.qvac, ~/.qvac/models,
  # buyer QWEN3_8B_INST_Q4_K_M, worker QWEN3_5_9B_MULTIMODAL_Q4_K_M); so check dir exists and is > 5 GB.
  if [ -d "$QVAC_DIR" ]; then
    kb=$(du -sk "$QVAC_DIR" 2>/dev/null | awk '{print $1}')
    gb=$(( ${kb:-0} / 1024 / 1024 ))
    if [ "$gb" -gt 5 ]; then row PASS "QVAC model cache" "$QVAC_DIR ${gb} GB (size check only, > 5 GB)"
    else row FAIL "QVAC model cache" "$QVAC_DIR only ${gb} GB (want > 5 GB; 8B + 9B ~ 10 GB)" "warm sequentially: see spikes/p0.2-qvac/warm.ts (one process at a time)"; fi
  else row FAIL "QVAC model cache" "$QVAC_DIR missing" "warm sequentially: see spikes/p0.2-qvac/warm.ts (one process at a time)"; fi

  # Node 22 for the issuer
  N22="${ISSUER_NODE:-$HOME/.local/share/fnm/node-versions/v22.23.3/installation/bin/node}"
  if [ -x "$N22" ]; then
    n22v=$("$N22" -v 2>/dev/null)
    [[ $n22v == v22.* ]] && row PASS "node 22 (issuer)" "$n22v ($N22)" || row FAIL "node 22 (issuer)" "$N22 is $n22v" "set ISSUER_NODE to a Node 22 binary"
  else row FAIL "node 22 (issuer)" "$N22 not executable" "fnm install 22.23.3, or set ISSUER_NODE to a Node 22 binary"; fi
  [ -d "$ROOT/infra/regtest/issuer/node_modules" ] && row PASS "issuer node_modules" "installed" || row FAIL "issuer node_modules" "missing in infra/regtest/issuer" "pnpm regtest:setup"

  # frozen offline install
  if have pnpm; then
    if (cd "$ROOT" && pnpm install --frozen-lockfile --offline >/dev/null 2>&1); then row PASS "pnpm offline install" "frozen lockfile OK"
    else row FAIL "pnpm offline install" "failed (store incomplete?)" "with network: pnpm install --frozen-lockfile"; fi
  fi

  # regtest services (only when up)
  if [ "$REGTEST" = up ]; then
    listening "$ELECTRS_PORT" && row PASS "electrs :$ELECTRS_PORT" "listening" || row FAIL "electrs :$ELECTRS_PORT" "not listening" "pnpm regtest:down && pnpm regtest:up"
    if have curl && curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$PROXY_PORT/"; then row PASS "RGB proxy :$PROXY_PORT" "responds"
    else row FAIL "RGB proxy :$PROXY_PORT" "no HTTP response" "pnpm regtest:down && pnpm regtest:up"; fi
  else
    row SKIP "electrs / RGB proxy" "regtest down" "pnpm regtest:up (then pnpm regtest:setup)"
  fi
fi

echo "doctor role: $ROLE ($OS)"
echo
printf '%-6s %-26s %-44s %s\n' STATUS CHECK DETAIL FIX
printf '%s\n' "$(printf '%.0s-' {1..120})"
for r in "${ROWS[@]}"; do
  IFS='|' read -r s n d f <<<"$r"
  [ "$s" = PASS ] && f=""
  printf '%-6s %-26s %-44s %s\n' "$s" "$n" "${d:0:44}" "$f"
done
echo
[ "$FAIL" = 0 ] && echo "doctor: all checks passed" || echo "doctor: FAILED (see FIX column)"
exit "$FAIL"
