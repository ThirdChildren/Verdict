#!/usr/bin/env bash
# Verdict doctor (Fedora Legion). Checks only; installs nothing. Exit 1 if any check fails.
set -u

# Make tools visible from any shell (non-login, CI, script runners)
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
FNM_DIR="${FNM_PATH:-$HOME/.local/share/fnm}"
[ -x "$FNM_DIR/fnm" ] && export PATH="$FNM_DIR:$PATH"
command -v fnm >/dev/null 2>&1 && eval "$(fnm env --shell bash)" 2>/dev/null
DATA_DIR="${VERDICT_DATA_DIR:-$HOME/.verdict-data}"
MIN_FREE_GB="${MIN_FREE_GB:-30}"
BITCOIND_PORT="${BITCOIND_PORT:-18443}"
ELECTRS_PORT="${ELECTRS_PORT:-50001}"
PROXY_PORT="${RGB_PROXY_PORT:-3000}"

FAIL=0
ROWS=()
row() { # status name detail fix
  local s="$1"
  [ "$s" = FAIL ] && FAIL=1
  ROWS+=("$s|$2|$3|${4:-}")
}
have() { command -v "$1" >/dev/null 2>&1; }
listening() { ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"; }

# Node 24 via fnm
if have node; then
  v=$(node -v); [[ $v == v24.* ]] && row PASS "node 24 LTS" "$v" || row FAIL "node 24 LTS" "found $v" "fnm install 24 && fnm default 24 && exec \$SHELL"
else row FAIL "node 24 LTS" "not found" "curl -fsSL https://fnm.vercel.app/install | bash; exec \$SHELL; fnm install 24 && fnm default 24"; fi
have fnm && row PASS "fnm" "$(fnm --version)" || row FAIL "fnm" "not found" "curl -fsSL https://fnm.vercel.app/install | bash; exec \$SHELL"

# pnpm via corepack
if have pnpm; then
  pv=$(pnpm -v 2>/dev/null | tail -n1)
  src="pnpm"; have corepack && [[ $(command -v pnpm) == *corepack* || $(readlink -f "$(command -v pnpm)") == *corepack* ]] && src="pnpm via corepack"
  [ -n "$pv" ] && row PASS "pnpm" "$pv ($src)" || row FAIL "pnpm" "does not run" "corepack enable"
else row FAIL "pnpm" "not found" "npm install -g corepack@latest && corepack enable"; fi

# git
have git && row PASS "git" "$(git --version)" || row FAIL "git" "not found" "sudo dnf install -y git"

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
  if docker compose version >/dev/null 2>&1; then
    row PASS "docker compose" "$cv"
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
    row FAIL "port $PROXY_PORT free" "in use while regtest is down" "ss -ltnp | grep :$PROXY_PORT ; stop the owner (other regtest? ./regtest.sh stop)"
  else row PASS "port $PROXY_PORT free" "free (regtest down)"; fi
else
  row PASS "regtest state" "up (bitcoind :$BITCOIND_PORT listening)"
fi

# NVIDIA driver
if have nvidia-smi && nvidia-smi -L >/dev/null 2>&1; then
  g=$(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader | head -n1)
  row PASS "NVIDIA driver" "$g"
else row FAIL "NVIDIA driver" "nvidia-smi missing or failing" "sudo dnf install -y akmod-nvidia xorg-x11-drv-nvidia-cuda  # wait ~5 min, reboot, enroll MOK if Secure Boot"; fi

# Vulkan
if have vulkaninfo; then
  vs=$(vulkaninfo --summary 2>/dev/null)
  if echo "$vs" | grep -qi 'RTX 3080'; then row PASS "vulkan RTX 3080" "$(echo "$vs" | grep -i 'deviceName' | grep -i 3080 | head -n1 | sed 's/^ *//')"
  else row FAIL "vulkan RTX 3080" "GPUs: $(echo "$vs" | grep -i deviceName | sed 's/^ *//; s/  */ /g' | paste -sd, - )" "sudo dnf install -y vulkan-tools; check NVIDIA driver loaded (nvidia-smi), reboot"; fi
else row FAIL "vulkan RTX 3080" "vulkaninfo not found" "sudo dnf install -y vulkan-tools"; fi

# disk
mkdir -p "$DATA_DIR" 2>/dev/null
target="$DATA_DIR"; [ -d "$target" ] || target="$HOME"
free=$(df -BG --output=avail "$target" | tail -n1 | tr -dc 0-9)
[ "${free:-0}" -ge "$MIN_FREE_GB" ] && row PASS "free disk ($DATA_DIR)" "${free} GB" || row FAIL "free disk ($DATA_DIR)" "${free} GB < ${MIN_FREE_GB} GB" "free space: docker system prune -a ; rm old data; or set VERDICT_DATA_DIR"

# regtest services (only when up)
if [ "$REGTEST" = up ]; then
  listening "$ELECTRS_PORT" && row PASS "electrs :$ELECTRS_PORT" "listening" || row FAIL "electrs :$ELECTRS_PORT" "not listening" "cd ~/src/rgb-lightning-node && ./regtest.sh stop && ./regtest.sh start"
  if have curl && curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$PROXY_PORT/"; then row PASS "RGB proxy :$PROXY_PORT" "responds"
  else row FAIL "RGB proxy :$PROXY_PORT" "no HTTP response" "cd ~/src/rgb-lightning-node && ./regtest.sh stop && ./regtest.sh start"; fi
else
  row SKIP "electrs / RGB proxy" "regtest down" "pnpm regtest:up"
fi

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
