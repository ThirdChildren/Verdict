# Demo script: 5 minutes

Plan A (single Legion, verifier as a second process). Plan B with the Mac only changes where the verifier runs (`docs/DEMO_TOPOLOGY.md`). Two people: the **presenter** talks and clicks, the **operator** watches the terminals and runs the two commands marked `[operator]`.

Mandate text (copy it, do not retype): `Hire worker for CSV to JSON jobs, up to 5 tUSD in total, 2 per task, for 12 hours.`

## Timeline

| Time | Segment | Click | Say |
|---|---|---|---|
| 0:00 to 0:30 | **Problem** | Nothing; UI is on the empty screen (`docs/screenshots/01-empty.png`). | "Agents need money to hire other agents. Today you either hand them a wallet, which one prompt injection can drain, or you pay for attempts, not results. Verdict gives agents permissions, not wallets, and pays workers for outcomes, not attempts." |
| 0:30 to 1:15 | **Mandate and principal signature** | Click *Create mandate*, paste the mandate text, click *Draft mandate*. On the Review step read the big numbers aloud (ceiling, per task, expiry, allowed worker); open *Raw mandate (JSON)* only if asked. Click *Approve and sign* and show step 3 (signed by the principal, separate process). | "I am the principal. The mandate is a hard limit: 5 tUSD, 2 per task, 12 hours, one named worker. My key lives in a separate signer process; the buyer agent never sees it. The agent runs on a local Qwen3 8B through QVAC, no cloud." |
| 1:15 to 1:30 | **Start the "worker disappears" task** | Press `d` to open the demo console, switch *Disappears* on and check it reads `on` (that is the worker's real state), press `d` to close. Press `n` (New task), goal "Convert this CSV to JSON", amount 1. Wait until the rail row reads Locked and the stage shows step 2 done. Reopen the console (`d`) and switch *Disappears* off. | "This one will go wrong in the background: the worker takes the job and vanishes. Nothing is delivered, so the verifier never even runs; the funds just wait for the escrow deadline. After about 20 seconds the screen says so: Worker stopped responding, Verify skipped, waiting for refund. We come back to it." |
| 1:30 to 2:30 | **Normal task, PASS, live tokens** | `n`, amount 1. The new task is selected automatically. Point at the live model output and tok/s on the stage, and at the five-step stepper as it moves: Authorized, Funds locked, Work, Verify, Settled. | "The worker is a second local model, 9B on the RTX 3080. The buyer's tUSD is locked in an RGB Lightning HODL invoice: nobody can spend it until the verifier says PASS. The verifier runs a fixed test package in a sandbox; no model decides." On PASS: "Verdict PASS, the worker claims with the preimage, the budget bar shows the spend as committed." |
| 2:30 to 3:00 | **Sabotaged task, FAIL, refund** | Console (`d`): switch *Sabotaged* on, close. `n`, amount 1. Wait for FAIL on the Verify step. Console: switch it off.  | "This worker delivers a broken file on purpose. Verdict FAIL, the worker never gets the preimage, the escrow is cancelled and the budget bar goes back up. Payment for outcomes." |
| 3:00 to 3:20 | **Compromised agent blocked** | Press `d`, click *Simulate compromised agent* (or *Send malicious instruction* in the rail). The red Blocked row is selected; read the catalogue message and "Nothing was signed. No funds moved." | "Now the agent itself is compromised and tries to pay someone I never approved. The engine refuses with COUNTERPARTY_NOT_ALLOWED. The agent cannot sign: its only road to money is the engine's policy check. No funds moved." |
| 3:20 to 4:00 | **Back to the disappearing task** | Select the disappearing task in the rail (`j`/`k`). Point at the block ring `N of ~M blocks` (blocks since the lock). Press `d`, select that task first, click *Mine until refund* (replaces the operator command; the ring fills from live progress). Then point at the Refunded state and the budget bar rising. | "The worker never delivered and never claimed. The funds stay locked until the Lightning timeout, measured in Bitcoin blocks; on regtest we mine them. The counter is the real chain height. At expiry the payment fails back to us and the budget is released. No trust in the worker, no operator action on the money." |
| 4:00 to 4:20 | **Check it yourself** | Select the PASS task, press `i` (Details), tab *Proof*. Show the three lines "verified in your browser" and "Who signed what"; tab *Events* shows the raw signed messages. Operator can run `pnpm verifier:rerun -- --task <task id>` on request (the id is copied from the Proof tab); it fetches the delivery from the worker, re-runs the package in the sandbox and prints PASS/FAIL with the package and delivery hashes. | "The browser recomputes the contract hash, the delivery hash and the verdict links itself. Anyone can re-run the same package on the same delivery and get the same exit code." |
| 4:20 to 5:00 | **Limits and what's next** | Nothing. | "Honest limits: one verifier we trust per contract; FAIL is final in this MVP, no redelivery; the macOS sandbox is untested; the wallet daemon has no auth beyond loopback. All in `docs/LIMITS.md`. Next: several verifiers with a quorum, redelivery, more task types, mainnet RGB-LN. Prepared before the event in `verdict-prep`, rebuilt here from the playbook." |

### Mining

Preferred: the demo console's *Mine until refund* (needs the engine started with `VERDICT_DEMO_TOGGLES=1`, loopback only; refusals are explained on screen, e.g. another payment still in flight). Fallback for the operator: `pnpm demo:expire` mines one regtest block at a time until the disappearing task's payment is Failed (about 60 to 70 s; 94 blocks in the P3.3 run, capped at 200). It ages **every** open lock, so run it only after the PASS and FAIL tasks are finished (their escrows are settled or released), as in the table. If you start it earlier, a task still in flight can time out. Nothing in the repo rehearses mining while another task is in flight; do not do it on stage.

## T-15 min checklist (operator)

1. Power: AC connected, `powerprofilesctl set performance`, browsers and other GPU users closed. `nvidia-smi --query-compute-apps=pid,used_memory --format=csv` is empty.
2. `pnpm demo:reset` (starts the wallet daemons, opens the channel, about 60 s). **Never restart a wallet daemon alone**: a restart leaves a channel whose HTLCs never become Claimable. If a daemon is down, run `pnpm demo:reset` again.
3. `pnpm preflight` green (bench, reset, claim and cancel on real regtest). It runs a reset itself; do not reset again after it unless something fails.
4. `pnpm verifier:hash` prints the hash the verifier log shows at start (`package <hash>`).
5. Plan A: `pnpm dev:verifier` in terminal 2. Then `pnpm dev:stack --wallet` in terminal 1. Wait for the banner (UI URL, worker name, tUSD asset id) and for both models loaded.
6. Models warm: run one throw-away task (it consumes budget, so `pnpm demo:reset` again only if you want a full 5 tUSD; the mandate is re-signed on stage anyway). First generation after a load is the slow one.
7. `/api/chain` answers (`curl -s http://127.0.0.1:7401/api/chain` returns a height). If 503, the bitcoind RPC env is wrong.
8. Browser: present in fullscreen (F11) at browser zoom 100% (check with Ctrl+0). Presenter size (`p`, about 125% type) stays off at 1280x640 or smaller, because the Settled, Refunded and worker-disappears scenes are only verified to fit without scrolling at 100% (1280x640); switch it on only for 1440x900 or larger. `?` once to check shortcuts, `d` once to check the console exists (else `VERDICT_DEMO_TOGGLES=1` is missing), one tab, notifications off, mandate text in the clipboard.
9. Backup recording of a full run is open in a second window, paused.

## Fallbacks

| Symptom | Do |
|---|---|
| Worker is slow (model thinking) | Presenter narrates the worker lane: attempts 1/3 to 3/3, self-check through the same `verify.sh`, live tokens. Do not click anything. A slow run once seen (about 7 tok/s) did not reproduce; see `docs/SETUP.md`. |
| Stall alert in the worker lane ("waiting for the payment ...") | The channel is not locking funds. Say it plainly, then `pnpm demo:reset` (about 60 s) and re-sign the mandate. Use the reset time to tell the problem and architecture story again. Do not restart a daemon. |
| Verifier on the Mac is down (plan B) | `docs/DEMO_TOPOLOGY.md`, "2-minute fallback", then continue on one machine. |
| `/api/chain` 503 during the disappearing task | The counter disappears; the payment still fails at expiry. Say "the counter needs our bitcoind connection, the expiry does not". |
| Total failure | Play the backup recording, say so, and show `pnpm test:e2e` results from the last green run. Never present the recording as live. |
