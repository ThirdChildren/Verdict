# Machine setup (do all of this before 17 October)

Goal: on the morning of the event, nothing needs to be downloaded or compiled. Commands are for current Fedora (dnf5). If a command fails, paste the error into Claude Code and ask for the Fedora fix; do not improvise with random blog posts. After each block, run the check line.

---

## Legion 7 (Fedora) — runs everything except the verifier

### 1. Base tools
```bash
sudo dnf upgrade --refresh -y
sudo dnf install -y git gcc gcc-c++ make pkgconf-pkg-config openssl-devel python3 jq curl vulkan-tools bubblewrap
```
`bubblewrap` is used by the Linux sandbox of the verifier runner.
Check: `git --version && gcc --version | head -1 && bwrap --version`

### 2. NVIDIA driver (RTX 3080) and Vulkan
```bash
sudo dnf install -y \
  https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm \
  https://mirrors.rpmfusion.org/nonfree/fedora/rpmfusion-nonfree-release-$(rpm -E %fedora).noarch.rpm
sudo dnf install -y akmod-nvidia xorg-x11-drv-nvidia-cuda
# wait ~5 minutes for the kernel module to build, then:
sudo reboot
```
With Secure Boot on, Fedora asks you to enroll a key (MOK) at the next boot. Follow the blue screen, or the driver will not load.
Check: `nvidia-smi` shows the RTX 3080, and `vulkaninfo --summary` lists the NVIDIA GPU (not only the AMD iGPU).

Speed check before a demo (measured 2026-10-11 on AC power, platform profile `performance`; `vulkaninfo` lists GPU0 AMD iGPU, GPU1 RTX 3080, GPU2 llvmpipe): 9B worker ~64 tok/s, 8B buyer loaded alongside makes no difference, load ~12 s per model. A run at ~7 tok/s and 30 s load was seen once (P3.2) and did not reproduce; if it returns, `nvidia-smi` should show ~95 % GPU use and ~5.7 GB per 9B process during generation. Stay on AC power and set `powerprofilesctl set performance` (or `/sys/firmware/acpi/platform_profile`); close browsers and other GPU users; `pnpm dev:stop` leaves no stale model process (`nvidia-smi --query-compute-apps=pid,used_memory --format=csv` must be empty before starting). QVAC 0.21.0 has no device selector (only `gpu_layers`), so a pinned device is not available through the SDK.

### 3. Node 24 + pnpm
```bash
curl -fsSL https://fnm.vercel.app/install | bash
exec $SHELL
fnm install 24 && fnm default 24
fnm install 22   # Node 22 only for the setup-only tUSD issuer (infra/regtest/issuer, ADR-020)
npm install -g corepack@latest && corepack enable
```
pnpm itself gets pinned per repo through the `packageManager` field (scaffold step P1.1).
Check: `node -v` (v24.x) and `pnpm -v`. The issuer needs Node 22.23.x: `fnm use 22` in its folder, or put its `bin` on PATH (`fnm` installs under `~/.local/share/fnm/node-versions/`).

### 4. Rust (needed only to compile the RLN binding at install time)
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
exec $SHELL
rustup toolchain install 1.88.0 --profile minimal
```
Check: `cargo --version && rustup toolchain list` (1.88.0 listed).

### 5. Containers for regtest — choose ONE
`podman-docker` and Docker both install `/usr/bin/docker`; never install both.

**A. Podman (already on Fedora)**
```bash
sudo dnf install -y podman-docker docker-compose
systemctl --user enable --now podman.socket
echo 'export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock' >> ~/.bashrc && exec $SHELL
mkdir -p ~/.config/containers
printf 'unqualified-search-registries = ["docker.io"]\n' >> ~/.config/containers/registries.conf
```
**B. Docker CE (the setup the organizers tested)**
```bash
sudo dnf config-manager addrepo --from-repofile https://download.docker.com/linux/fedora/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker $USER   # then log out and back in
```
Check: `docker compose version`. Then run the regtest test in step 6. With Podman, if it still fails after 30 minutes, switch to B (remove `podman-docker` first).

### 6. Run the official regtest once (downloads the images)
```bash
mkdir -p ~/src && cd ~/src
git clone https://github.com/RGB-Tools/rgb-lightning-node --recurse-submodules --shallow-submodules
cd rgb-lightning-node && ./regtest.sh start
# when it says the services are up:
./regtest.sh stop
```
With Podman and "permission denied" on `./datacore` or similar, add `:z` to those volume lines in `compose.yaml` (SELinux label) and retry.
Check: the start finishes without errors, and `ss -ltn | grep :3000` is empty after the stop.

### 7. Prep repository + kit
```bash
mkdir -p ~/src/verdict-prep && cd ~/src/verdict-prep
git init
unzip ~/Downloads/verdict-claude-kit.zip && cp -r verdict-kit/. . && rm -rf verdict-kit
git add . && git commit -m "chore: add Claude Code kit (CLAUDE.md, agents, docs)"
```
Create the empty GitHub repo `verdict-prep` and push. It is the record of the preparation that the event repo links to.
Install Claude Code by following the official setup page (code.claude.com/docs), then start it in this folder with `claude`.

### 8. Things the spikes download (they happen in P0, listed here so nothing is forgotten)
- `pnpm install` with the RLN binding allowed: compiles RLN in Rust (expect several minutes or more).
  - Measured 2026-10-10 (P2.2): `RLN_NODE_SOURCE_DIR=../rgb-lightning-node pnpm install` took 1.7 s because the pnpm store already held the addon built during P0.3 (no Rust compile ran). The original from-scratch compile time was not recorded; a cold store means the full ~20 min build. Run with `RLN_NODE_SOURCE_DIR` set to the local checkout to avoid cloning.
  - `@qvac/sdk` 0.21.0 is now a devDependency of `@verdict/llm` (about 5 min to install).
- QVAC models for buyer and worker (spike P0.2): note the cache path it prints, for the cleanup later.
- Docker/Podman images for regtest (step 6).
Final check before the event: `scripts/doctor.sh` is all green, and `pnpm install --frozen-lockfile --offline` works.

---

### Dev stack
- `pnpm dev:stop` frees ports 7401-7403, 7411-7412 and 5173, killing only processes that belong to this repo, and prints what it killed (wallet daemons too: their channel is lost until `pnpm demo:reset`).
- `pnpm dev:stack` runs `dev:stop`, then engine, principal-signer, buyer-agent and demo-ui with labelled logs; with `--wallet` it also starts the worker and verifier but **never** the wallet daemons: it refuses to start if they are down. Only `pnpm demo:reset` starts them (with the channel).
- It prints a banner when everything listens and the buyer model is loaded: UI URL, the worker name to use in mandate text, tUSD asset id.

### UI screenshot loop (Legion, dev only)
- `@playwright/test` 1.64.0 (published 2026-10-07). Chromium only: `pnpm exec playwright install chromium` downloads Chromium 156 + headless shell to `~/.cache/ms-playwright/` (about 660 MB on disk per revision, 120 MiB download for the shell). No `allowBuilds` entry needed (no install script).
- `pnpm ui:shots [scene-id ...]` starts vite on port 5199, opens `?mock=1`, and writes `.logs/shots/<scene>-<viewport>-<theme>.png` (1440x900 and 1280x720, light and dark). Extra views are listed in `scripts/ui-shots.ts` (`EXTRAS`).

## Teammate's Mac — runs only the verifier

```bash
# Homebrew if missing: see brew.sh
brew install fnm git
fnm install 24 && fnm default 24
npm install -g corepack@latest && corepack enable
```
No Rust, no containers, no models. `sandbox-exec` is built into macOS (spike P0.5 confirms it works).
Check: `node -v`, `pnpm -v`, and the Mac can reach the Legion over cable or hotspot (`ping <legion-ip>`).

---

## Cleanup after the hackathon (Legion)

```bash
docker compose down -v                    # in each regtest folder (or podman compose)
docker system prune -a --volumes          # or: podman system prune -a --volumes
rm -rf ~/.verdict-data ~/src/rgb-lightning-node
rustup self uninstall
rm -rf ~/.local/share/fnm                 # Node via fnm
# QVAC models: delete the cache folder noted in step 8
```
