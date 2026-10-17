# Known limits (accepted)

Found in the read-only security reviews of the funds path and judged Low. Say them honestly if asked.

1. **PREIMAGE travels in plaintext HTTP on the LAN** (`services/capability-engine` to `peers.worker`). It is signed and bound to the payment hash, and only the payee node can claim, so a leaked P cannot be used to steal funds. But a changed `peers.json` or `WORKER_URL` would send P to the wrong host. Plan A (single Legion) uses loopback. Later fix: sealed box to the worker's key, or take the worker URL from the signed contract.
2. **Peers are not allow-listed.** `VERIFIER_URL` / `WORKER_URL` / `ENGINE_URL` override `peers.json`, and LAN peers are plain http. Mitigation: keep `peers.json` at 0600 and check the resolved peers at startup.
3. **`claimHodlInvoice` in the wallet adapter does not check sha256(P) == H itself.** The worker node does before it calls the adapter, so no current caller is exposed. Later fix: check in the adapter too.
4. **Wallet daemon has no authentication beyond loopback and Host checks.** Any local process of the same user can call `POST /payments`. Accepted by design for the demo machine.
5. **macOS verifier sandbox has no memory cap** (see `docs/MAC_VERIFIER.md`).

Not covered by that review: `escrow.ts` HTLC and invoice-match checks, the sandbox runner, protocol signing and domain separation, `wallet-client.ts` internals, the UI, dependencies, `selftest.ts`.
6. **macOS verifier: host files are readable by the delivery.** The Seatbelt profile is `allow default` with explicit denies: the run dir (package copy with the expected answers), the verifier package, the data dir and the repository checkout are hidden, writes are confined to scratch and the network is blocked, but any other file on the Mac (home, `/etc`) can be read by a hostile delivery. It cannot exfiltrate over the network. The Linux sandbox (bwrap) shows no host path at all. Found and documented on 17 Oct 2026 when the verifier first ran on a Mac.
7. **macOS: fork-bomb and allocation tests are timing-sensitive under load.** `runner.test.ts` passed 40/40 in isolation but one of four runs failed while other processes were busy. `pnpm verifier:selftest` covers both cases and is the check that matters before a demo.
