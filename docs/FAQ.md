# Questions a reviewer may ask

Rule we hold ourselves to: no claim without a file, a test or a run behind it. Each answer names its evidence.

**Is the payment real or simulated?**
Real RGB tUSD over Lightning on a local regtest. Fakes exist only in unit tests and refuse to run under `VERDICT_MODE=demo` (`packages/wallet/src/fake-wallet.ts`, `packages/llm/src/fake.ts`). We have not run on a public network; Mutinynet is a stretch goal (`docs/DECISIONS.md`, ADR-017).

**Why HODL invoices?**
The payee must not be paid on a promise, and the payer must not be able to take the money back early. A HODL invoice holds the HTLC until the preimage is revealed; the buyer side reveals it only after a signed PASS, and a timeout refunds. Only the UTEXO fork of the RGB Lightning node provides them; the organizers approved it on 2026-10-09 (ADR-016). Lifecycle on regtest: `tests/e2e/hodl-lifecycle.e2e.ts`.

**Is the model given a parsing hint? Isn't that cheating?**
Yes, and no. The worker prompt states the output format with one worked example (`services/worker/src/agent/generate.ts`) and the worker self-checks with the same `verify.sh` before delivering. The verifier never sees the hint: the expected outputs stay hidden from the executor (`services/verifier/src/runner.ts`, sandbox section).

**What if the verifier lies?**
Then it can wrongly pay or wrongly refuse. The MVP trusts one verifier named in the signed contract; it cannot be changed after signing. The package is content-hashed and the verdict is signed, so a wrong verdict is provable by re-running `pnpm verifier:rerun -- --task <id>` on the same delivery. Several verifiers with a quorum are future work (`docs/LIMITS.md`).

**Is this custodial?**
The principal's key lives in a separate signer process (`apps/principal-signer`). The engine holds the buyer's wallet and the preimage in a local SQLite file on the principal's own machine (mode 0600): custodial of the budget the principal assigned, on the principal's hardware, never a third party. The worker claims with its own wallet.

**Why a local model?**
The buyer sees budgets and contracts; the worker sees customer data. Neither should leave the machine, and a spend decision should not depend on a cloud API being up. The model never signs: it proposes spend intents that the engine validates, so a weaker model costs quality, not safety (`services/capability-engine/src/policy/`).

**Can the worker run malicious code on the verifier?**
The delivery runs in a sandbox with no network, a scrubbed environment, resource limits and a separate judge process: `bwrap` on Linux, `sandbox-exec` on macOS (`docs/ARCHITECTURE.md` section 9, `pnpm verifier:selftest`). Known limits of the macOS sandbox are in `docs/LIMITS.md`.

**What breaks if a wallet daemon restarts?**
The RGB channel stays open on paper but its HTLCs never become claimable, so tasks stall before delivery. Funds are not lost: the HTLC times out. Recovery is `pnpm demo:reset` (ADR-023); the dev stack therefore never restarts daemons, and the UI shows a stall alert.

**Can I create a second mandate?**
Yes: NEW MANDATE in the header. A new root retires the previous one and its unused permissions, returns the unused budget, and lets a task already in flight finish under its own permission (`docs/ARCHITECTURE.md`, mandate section).

**What is the real product after Sunday?**
A policy layer for agent spending: budgets, attenuated delegations, escrow with verifiable outcomes, signed receipts. The first user is a team running agents that buy services. Honest gap: one task type, one verifier, no customer yet.
