# Demo topology: one machine or two

Peers are read by `loadPeers` (`packages/identity/src/peers.ts`). Order: `ENGINE_URL` / `WORKER_URL` / `VERIFIER_URL`, then `~/.verdict-data/peers.json`, then loopback defaults. The only thing that changes between plans is where the **verifier** is.

## Plan A: single Legion (default)

Everything runs on the Legion; the verifier is a second process on loopback.

- Legion `~/.verdict-data/peers.json`: absent, or `{}`, or `{ "verifier": "http://127.0.0.1:7404" }`. No `VERIFIER_URL` in the environment.
- Terminals: `pnpm dev` and, in another, `pnpm dev:verifier` (no `VERDICT_LAN_BIND`).
- The verifier key lives on the Legion (`pnpm verifier:keys`, then `pnpm keys:set-verifier -- ed25519:...`).
- Say honestly on stage: "the verifier is a separate process with its own key and no wallet; on a second machine it works the same way".

## Plan B: Legion plus Mac (only if the Friday test passes)

Friday 16 Oct test, all must pass, otherwise stay on plan A:
1. Mac: `pnpm verifier:selftest` prints PASS on every line (one SKIP allowed).
2. The Mac's `pnpm verifier:hash` equals the Legion's.
3. The `curl` check in `docs/MAC_VERIFIER.md` section 7 prints `400` from the Legion.
4. `pnpm test:e2e:lan` is green with the Mac as verifier, twice in a row, over the same cable or hotspot used at the event.

Switch values:

| Machine | `~/.verdict-data/peers.json` | Start |
|---|---|---|
| Legion | `{ "verifier": "http://MAC_IP:7404" }` | `pnpm dev` (no local verifier) |
| Mac | `{ "engine": "http://LEGION_IP:7401", "worker": "http://LEGION_IP:7405" }` | `VERDICT_LAN_BIND=MAC_IP pnpm dev:verifier` |

Same thing with env vars: `VERIFIER_URL=http://MAC_IP:7404 pnpm dev` on the Legion. The Mac holds the verifier key, and the Legion's `identities.json` carries its public id. Use fixed addresses (cable with static IPs, or the Legion's hotspot) and never the venue Wi-Fi.

## 2-minute fallback if the Mac fails on stage (plan B to plan A)

The verifier public id differs between machines, so the Legion needs its own verifier key before the event. Prepare once, on Friday:
- `~/.verdict-data/identities.legion-verifier.json` (identities with a Legion-held verifier id) and `~/.verdict-data/keys/verifier.key` generated on the Legion (`pnpm verifier:keys`). Keep a copy of the Mac variant as `identities.mac-verifier.json`.

On stage:
1. (0:00) Say "the second machine dropped, we continue on one machine". Do not improvise anything else.
2. (0:10) Legion: `pnpm dev:stop`. Edit `peers.json` to `{}` (or delete the `verifier` entry); make sure `VERIFIER_URL` is unset in this shell.
3. (0:30) `cp ~/.verdict-data/identities.legion-verifier.json ~/.verdict-data/identities.json`.
4. (0:45) Terminal 2: `pnpm dev:verifier`. Check that the log shows `package <hash>` equal to `pnpm verifier:hash`.
5. (1:15) `pnpm dev`. Then `pnpm demo:reset` (channels are kept).
6. (2:00) Run the scenario again. Tasks that were in flight during the failure are abandoned by the reset; the HTLC timeout would refund them, so no funds are lost.

Rehearse this once on Friday with a stopwatch. If it takes longer than 2 minutes, plan A is the demo.

## Mandate text for the demo

Say the duration: `Hire worker for CSV to JSON jobs, up to 5 tUSD in total, 2 per task, for 12 hours.`
Default is 12 h (hard limit 24 h). The review dialog refuses a mandate shorter than 2 h: a task permission lasts as long as the mandate, and a task whose deadline is later than that is blocked as "ends before this task's deadline".

## Rule: never restart a wallet daemon alone

A wallet daemon restart breaks HTLCs: the RGB channel stays open on paper but its HTLCs never become Claimable, so tasks stall at "invoice sent". If a daemon is down, run `pnpm demo:reset` (it starts the daemons and opens a fresh channel). `pnpm dev:stack --wallet` refuses to start when the daemons are not running and never restarts them.
