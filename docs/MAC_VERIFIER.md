# Mac verifier: step by step

You run **only the verifier**. It holds one key (its own), no wallet, no model, no Rust. It judges the worker's delivery with a fixed test package and signs the verdict. Nothing the worker sends is trusted: it runs in a sandbox with no network.

Time: about 10 minutes after the clone, no builds.

## 0. What you need from the Legion person
- the repo URL (clone it) and the same commit they run (`git rev-parse --short HEAD` on the Legion),
- the Legion's address on the cable or hotspot (call it `LEGION_IP`),
- later, a copy of `identities.json` (public ids only, safe to send by any chat).

## 1. Tools (once)
```bash
brew install fnm git            # Homebrew first if missing: brew.sh
fnm install 24 && fnm default 24
eval "$(fnm env --use-on-cd)"   # or open a new terminal
npm install -g corepack@latest && corepack enable
node -v                          # must print v24.x
```

## 2. Clone and filtered install
```bash
git clone <repo-url> verdict && cd verdict
git checkout <commit-the-legion-runs>
pnpm install --frozen-lockfile --filter "@verdict/verifier..."
```
The filter installs the verifier and what it needs, nothing else. It must **not** download or compile the RGB Lightning binding (Rust) or QVAC. Quick check: `ls node_modules/.pnpm | grep -ci "utexo\|qvac"` prints `0`.

## 3. Selftest: is this Mac safe to run the verifier?
```bash
pnpm verifier:selftest
```
It runs honest and hostile deliveries through this Mac's sandbox and prints PASS or FAIL for each: an honest delivery, a broken one, one that overwrites the expected answers, one that reads them, one that writes outside its folder, a network attempt, a fork bomb, a hanging program and a gzip bomb. Every line must say PASS (one line may say SKIP: the memory-hog test is not run on macOS, see "Known limits").
If any line says FAIL: stop and tell the Legion person which one. Do not run the verifier.

## 4. Your verifier key (this one never leaves the Mac)
```bash
pnpm verifier:keys
```
It creates `~/.verdict-data/keys/verifier.key` (owner-only) and prints `public id (send this to the Legion): ed25519:...`. Send that **public** id to the Legion person. Never send the key file.

The Legion person runs `pnpm keys:set-verifier -- ed25519:...`, then sends you their `~/.verdict-data/identities.json`. Put it at the same path on the Mac: `~/.verdict-data/identities.json`. It holds public ids only. The verifier refuses to start if its key does not match the id in that file.

## 5. Tell the verifier where the Legion is
Create `~/.verdict-data/peers.json` (replace the address):
```json
{ "engine": "http://LEGION_IP:7401", "worker": "http://LEGION_IP:7405" }
```
(Same thing without a file: `ENGINE_URL=... WORKER_URL=...` in the command below.)

## 6. Run it, listening on the LAN
Find your Mac's address on the cable or hotspot: `ipconfig getifaddr en0` (try `en1`, `en2` if empty). Call it `MAC_IP`.
```bash
VERDICT_LAN_BIND=MAC_IP pnpm dev:verifier
```
- macOS asks "Do you want the application "node" to accept incoming network connections?" → **Allow**. If you clicked Deny by mistake: System Settings → Network → Firewall → Options → set `node` to "Allow incoming connections".
- The log shows `package <hash> sandbox sandbox-exec`. Tell the Legion person the hash: it must equal `pnpm verifier:hash` on the Legion.
- Only signed `POST /v0/messages` is reachable from the LAN. Everything else, including `/health`, answers 403 to other machines. That is intended.

## 7. Give the Legion the verifier URL
Send `http://MAC_IP:7404`. On the Legion, in `~/.verdict-data/peers.json`: `{ "verifier": "http://MAC_IP:7404" }` (or `VERIFIER_URL=http://MAC_IP:7404`), then `pnpm dev`. Check from the Legion: `curl -s -o /dev/null -w "%{http_code}\n" -X POST -H 'content-type: application/json' -d '{}' http://MAC_IP:7404/v0/messages` prints `400` (reached, empty message refused). `403` means the Host does not match `VERDICT_LAN_BIND`; a timeout means firewall or wrong network.

## Known limits (be honest about them at the demo)
- The macOS sandbox (`sandbox-exec`) blocks network, file writes outside scratch and reads of the test answers; it limits processes and CPU time but **has no memory cap**. The wall-clock timeout kills a runaway program; a memory hog can still use RAM for up to the per-case time limit. The Linux sandbox has the memory cap.
- `sandbox-exec` is deprecated by Apple but works on current macOS.
- If something fails, copy the terminal output to the Legion person; the log never prints the preimage or keys.
