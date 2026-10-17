# Decisions (ADR log)

Short records of choices that shape the code. Add one entry per protocol change or dependency change. Newest at the bottom.

---

### ADR-001 — No Tauri / Rust backend for the MVP
**Decision:** Backend services are Node.js + TypeScript. The UI is a Vite web app opened in the browser.
**Why:** QVAC (`@qvac/sdk`), WDK (`@tetherto/wdk`) and the RGB Lightning module (`@utexo/wdk-rgb-lightning` with its Node binding) are all JavaScript packages. A Tauri/Rust backend would have to spawn Node sidecars for every one of them, adding a second toolchain, IPC and packaging risk for zero gain in the judged criteria. rgb-lightning-node is already Rust, embedded through N-API bindings. We write no Rust ourselves, but the binding compiles RLN at install time, so the Legion needs `rustup` (see ADR-015).
**Revisit:** after the hackathon, Tauri can wrap the same UI as a desktop shell without touching the services.

### ADR-002 — Runtime and workspace
Node.js 24 LTS, pnpm workspaces, TypeScript strict, ESM only, `tsx` to run services in development (no build step for services), Vite for the UI.

### ADR-003 — HTTP and events
Fastify for HTTP, `@fastify/websocket` for UI event streams. Services expose `POST /v0/messages` for signed protocol messages and `GET /v0/events` (WebSocket) for UI updates.

### ADR-004 — Schemas
Zod v4 is the single source of truth for every message, capability, contract and LLM output. JSON Schema for QVAC `responseFormat` is generated with `z.toJSONSchema` (Zod v4 is also what `@qvac/sdk` depends on).

### ADR-005 — Hashing and canonical JSON
RFC 8785 JCS via the `canonicalize` package; sha256 via `@noble/hashes` 2.4.0 (isomorphic: the protocol core has no `node:*` imports, randomness is `globalThis.crypto.getRandomValues`; fs helpers live in `@verdict/protocol/node`; a test enforces it). _Amended 2026-10-10 (was `node:crypto`)._ Signing strings are domain-separated: `verdict:v0:<TYPE>:<hash>`.

### ADR-006 — Control-plane signatures
**Decision (spike P0.4, 2026-10-10): Plan A for principal, engine and worker; Ed25519 (libsodium) for the Verifier.** Both sit behind one `Signer` interface; a public id carries its scheme (`eip191:0x…` / `ed25519:<hex>`), so the switch is a config change.
**Evidence (all run, scripts/spikes/p0.4):** the WDK EVM account signs EIP-191 and a seedless `WalletAccountReadOnlyEvm(address).verify` (or plain `ethers.verifyMessage`) verifies from the address alone. The RGB-LN account `verify` needs a running unlocked node and takes no pubkey, so it is not usable for this. The Verifier has no wallet by design, so it signs verdicts with its own Ed25519 key; Ed25519 verify and `crypto_box_seal` to its X25519 key also pass.
**Why:** WDK signing is central for the WDK bonus and costs nothing in verification; the Verifier stays free of WDK. Fallback: Ed25519 for everyone if the EVM module breaks (it moves fast: beta.20 -> beta.21 in 9 days; pin beta.20, no bumps).
**Cost:** one more official dependency (`@tetherto/wdk-wallet-evm`, no build script). Signing identity (EVM address) differs from the LN node id; contract binds both.

### ADR-007 — Preimage transport
`crypto_box_seal` (libsodium sealed box) to the Verifier's X25519 key. No custom crypto constructions.

### ADR-008 — Budget ledger
SQLite via `better-sqlite3` (synchronous transactions) in `capability-engine`. Reservation insert and remaining-budget check happen in one transaction before the wallet call.

### ADR-009 — Wallet and Lightning
`@tetherto/wdk` manager + `@utexo/wdk-rgb-lightning` + `@utexo/rgb-lightning-node-nodejs`, exact versions pinned. Regtest stack: organizer-provided if available, otherwise the official RGB-Tools Docker Compose regtest (rgb-lib `tests/regtest.sh` or RLN `regtest.sh`), with the UTEXO demo stack as a fallback. Container runtime: the organizer scripts only call `docker compose`, so either Docker or Podman (with the `podman-docker` shim and a Compose provider) can run them. Docker is the tested path; Podman on Fedora is allowed once `./regtest.sh start` is proven to work, with a 30-minute time box and Docker as the fallback. Fallback if the module misbehaves: build the UTEXO RLN binary (`cargo install --locked --path .`) and drive its REST API directly (`/lninvoice` with `payment_hash`, `/claimhodlinvoice`, `/cancelhodlinvoice`). Upstream RGB-Tools RLN does not have these endpoints.

### ADR-010 — Local AI
`@qvac/sdk` with llama.cpp (Vulkan on the RTX 3080). Structured outputs with `responseFormat: json_schema` and Zod re-validation. Initial models: `QWEN3_4B_INST_Q4_K_M` (buyer), `QWEN3_5_9B_MULTIMODAL_Q4_K_M` (worker). Final choice after spike 2.

### ADR-011 — Verifier sandbox
Temp dir + timeout + scrubbed env + no network (`sandbox-exec` deny-network profile on macOS, `unshare -rn` / `bwrap` on Linux). Not a hardened sandbox; declared as such in the pitch.

### ADR-012 — Frontend libraries
| Need | Library | Why |
|---|---|---|
| Build / dev server | Vite | fast, zero config for React + TS |
| UI framework | React 19 + TypeScript | team familiarity, ecosystem |
| Styling | Tailwind CSS v4 (`@tailwindcss/vite`) | requested; fast iteration |
| Components | shadcn/ui on Radix primitives | accessible dialogs, alerts, tooltips, tabs; code lives in the repo |
| Server state | TanStack Query v5 | mutations (sign, approve) with loading/error states |
| Live state | Zustand | one store fed by the three WebSocket streams |
| Forms | React Hook Form + `@hookform/resolvers/zod` | mandate form validated with the same Zod schemas |
| Icons | lucide-react | consistent stroke icons |
| Motion | motion | subtle stepper and budget-bar transitions |
| Toasts | sonner | shadcn default, non-blocking notices |
No router: one screen with lanes; dialogs for detail.

### ADR-013 — Testing
Vitest for unit and integration (with `FakeWallet` / `FakeLlm`), fast-check for property tests of capability attenuation, e2e scripts against real regtest in `tests/e2e`. Fakes refuse to construct when `VERDICT_MODE=demo`.

### ADR-014 — Tooling
Biome for lint + format, pino (+ pino-pretty in dev) with redaction of secrets, `concurrently` for labelled multi-service logs.

### ADR-015 — Dependency policy
Official sources only (CLAUDE.md "Dependencies"). Before pinning: `npm view` for latest version and date, read release notes and `.d.ts`, pin exact, commit the lockfile, record in `docs/SDK_NOTES.md`. Upgrades only after a spike. Dependency build scripts are approved one by one with `allowBuilds` in `pnpm-workspace.yaml`. Everything that downloads is fetched before the event; version freeze on 16 Oct evening.

### ADR-016 — RGB stack compliance and the HODL source
**Context:** the organizers ask for RGB-Tools / rgb-protocol only, v0.11.1. Our escrow needs HODL invoices, which only the UTEXO fork of rgb-lightning-node provides (same v0.11.1 protocol line, `rgb-*` 0.11.1-rc.10).
**Decision:** use the UTEXO stack (`@utexo/wdk-rgb-lightning` + `@utexo/rgb-lightning-node-nodejs`). **Approved by the organizers (Birk, RGB) on 2026-10-09.** Declared in the README and the pitch.
**Plan B (kept only for reference):** upstream RLN without HODL would need a custodial escrow node and a protocol change.

### ADR-017 — Network for development and demo
**Options:** (a) local regtest with the UTEXO nodes; (b) Mutinynet, a public signet with ~30 s blocks, with Kaleido's esplora/proxy, the Mutinynet BTC faucet, the RGB asset faucet (USDT/XAUT) and the KaleidoSwap LSP.
**Decision:** local regtest is the primary for development, tests and the live demo. Mutinynet is an optional stretch after integration works (spike 8).
**Why:** the refund scenario needs blocks on demand (`regtest:mine`); on Mutinynet an HTLC timeout means many 30 s blocks. Regtest runs offline, so the demo does not depend on venue internet, public faucets or rate limits (Kaleido's esplora has returned 429). The demo also stays repeatable with `regtest:reset`. Kaleido's own nodes are RGB-Tools based and have no HODL, so Mutinynet would not save us from running our UTEXO nodes. The faucets save asset issuance, which is one script on regtest anyway.
**What Mutinynet could add:** a "this also runs on a public test network" moment with an explorer link and faucet USDT. Worth it only if spike 8 passes three times in a row before 16 Oct.

### ADR-018 — Build log and token budget
Every finished step is documented by the `scribe` subagent (Haiku) in a build log kept outside this repository. The build log is the context for the next session, used instead of re-reading code. Token rules live in CLAUDE.md "Token discipline": one step per session with `/clear`, narrow reads, package-scoped tests, reviews and e2e only at gates, reports of 150 words or less.

### ADR-019 — LLM-facing intent schema and buyer model
**Context:** P0.2 showed that QVAC's `responseFormat` grammar ignores regex patterns: with the protocol spend-intent schema the 4B model passed Zod only 1 time in 10 (amounts like "{1.10 tUSD}"). P0.2b showed that a regex-free schema gives 20/20 valid on 4B and 8B, including 5 adversarial inputs. Qwen3.5 9B fails on any `responseFormat` ("empty grammar stack"). 4B misread 2 of 15 amounts, 8B none of 15.
**Decision:**
- The buyer-agent uses a separate LLM-facing intent schema with no regex: integer `amount_minor` (1..100000), enums, length-bounded strings, one `interval` field from which `recurring` is derived in code, and `deadline_minutes`. Code converts it to the protocol schema (`amount_minor` → `bigint` → decimal string). The model never writes a formatted amount.
- Buyer model is `QWEN3_8B_INST_Q4_K_M`; `QWEN3_4B_INST_Q4_K_M` is the fallback.
- `responseFormat` is never used with Qwen3.5. Worker output is free text with thinking on.
- Every amount produced by the model must appear in the user's text; otherwise retry (max 2, with the error appended), then fail closed (BLOCKED, never a guess).
- Every output is re-validated with Zod; the UI shows the converted amount to the Principal.
**Why:** the grammar cannot enforce formats, so safety comes from Zod, the cross-check and the engine, never from the model. `packages/protocol` is untouched.

### ADR-020 — tUSD issuer: isolated setup-only dependency
**Context:** P0.3 showed that `account.issueAssetNia` on the WDK RGB-LN account throws `UnsupportedInExternalSignerMode`; the binding only runs in external-signer mode, so the RLN node cannot issue assets. An rgb-lib wallet is needed for issuance. `@utexo/rgb-sdk@1.0.3` (UTEXO, same org as the approved fork, ADR-016) does it. 1.0.6 fails to build on Node 24 exactly like 1.0.3 (node-gyp `SwigV8Arguments has no member named Holder` in rgb-lib 0.3.0-beta.13); it was not tried on Node 22. The npm `latest` tag is a stale beta.
**Decision (human-approved 2026-10-10):**
- `@utexo/rgb-sdk` is used only to issue tUSD at regtest setup, from `infra/regtest/issuer/` (own `package.json`, `.nvmrc` = Node 22, exact pin `1.0.3`, no caret).
- It is never added to the pnpm workspace and never imported by a service or the demo path. Services use only WDK + RGB-LN.
- Install it before the event (`fnm install 22`, then install in the issuer folder); nothing downloads on site.
**If it breaks:** (1) the same issuance through the rgb-lib API exposed by RLN's REST flavour, or (2) a prepared regtest snapshot (data dirs + issued asset) restored by `regtest:reset`. Decide with `sdk-researcher` before the freeze.
**Why:** it keeps an unvetted native build and a second Node major out of the product, while the demo still shows real RGB issuance.

### ADR-021 — Funds lock window
**Context:** P0.3 spike. How long funds stay locked is decided by `min_final_cltv_expiry_delta` (in blocks, decoded minimum 42), not by `expiry_sec`. With delta 42 the payment went to Failed after 45–128 mined blocks (varies), with 44 after 48, with 103 after 146.
**Decision:** `lock_window_seconds = min_final_cltv_expiry_delta * 600` (nominal). `expiry_sec` only bounds how long the invoice can be paid.
- The Task Contract (P1.2) gets two fields: `max_lock_seconds` and `safety_margin_seconds`. The delta is read from the decoded invoice, never declared by the worker.
- Invariant 4 in CLAUDE.md is reworded accordingly.
**Demo consequence:** the "expiry" step mines blocks one at a time until the payment is Failed, capped at 200 blocks.
**Why:** the check must use the value that actually governs the lock, and it must come from a source the worker cannot forge.

### ADR-022 — Protocol freeze 0.1.0
**Decision (human-approved 2026-10-10):** `@verdict/protocol` is frozen at `PROTOCOL_VERSION = "0.1.0"`. Further changes need a human yes in chat, a version bump and an ADR.
**Frozen:** canonical JSON and hashing (`canonical`, `hashObj`, `hashUnsigned`, `signingString` with domain `verdict:v0`), `dirHash`; amount helpers (precision required, max 18 digits); root/child capability, spend intent, Task Contract, Verdict Record, message envelope and bodies; the BLOCK/FAIL catalogue (incl. `LOCK_WINDOW_TOO_SHORT`/`LOCK_WINDOW_TOO_LONG`, renamed from `HTLC_EXPIRY_*`); the task transition table; `Signer`, `verifySignature`, `registerSchemeVerifier`, sealed-preimage helpers; scheme names `eip191`/`ed25519` (ADR-006).
**Decisions folded in:** child capability links its parent by the full 64-hex sha256 (`parent`; `cap_<16hex>` and `task_<16hex>` are display/DB keys); `contract_sha256 = hashUnsigned(contract)` (all signature fields stripped; `max_lock_seconds` and `safety_margin_seconds` stay inside the signed body); `ESCROW_LOCKED`/`VERDICT_WITHHOLD` -> `EXPIRED` only on an observed payment `Failed` or invoice cancelled, never on the wall clock; all ids and signatures are lowercase; the Verifier verifies only contract and delivery, the engine verifies the capability chain; the Verifier's X25519 key is derived from its Ed25519 key (one key for signing and sealing, MVP only: a compromise exposes both); the core is isomorphic (ADR-005).
**Not frozen:** UI events (`uiEventSchema`), versioned separately by `UI_EVENTS_VERSION`; `fixtures.ts` test data; the eip191 verifier (to be written in `packages/wallet`).

### ADR-023 — Wallet daemon per role; channels do not survive restarts
**Context:** P2.2 showed that a RLN node restarted over an existing channel cannot move HTLCs: the WDK module builds an ephemeral VLS signer, so LDK parks every new HTLC, and the persistent `createWithStorage` signer panics at restore (`vls-core channel.rs:119`).
**Decision (human, 2026-10-10):** do not debug this and do not evaluate the REST fallback now.
- `apps/wallet-daemon` runs once per role (buyer, worker), owns the node, opens and keeps the channel for its whole life, and listens on 127.0.0.1 only. Every call has an explicit timeout; `dispose()` errors after shutdown are swallowed and logged.
- Engine and worker agent use `WalletClient` (same `WalletPort` interface, over HTTP + WebSocket). The in-process `RlnWallet` stays inside the daemon.
- The channel is opened by the buyer daemon (`/v0/admin/open-channel`), never by a setup script, so the signer that opened it is the one that uses it. `regtest:setup` therefore has no channel phase.
- `pnpm demo:reset` = stop daemons, regtest reset, seeds/fund/tUSD, start daemons, open channel; it prints its duration. `pnpm preflight` = reset + one claim + one cancel, exit 1 on any failure.
- Demo contract `max_lock_seconds` defaults to 28800 (real lock 25 200 s).
**Consequences:** a crashed daemon means `pnpm demo:reset` (minutes, not seconds); never restart a daemon on stage. **If it breaks:** evaluate the RLN REST flavour or a prepared snapshot.

### ADR-024 — Protocol 0.1.1 (additive)
**Decision (human-approved 2026-10-10):** `PROTOCOL_VERSION = "0.1.1"`. Additive only, wire version unchanged.
- `SPEND_INTENT` message body `{ cap_hash, intent }` and signed envelope type, signed by the child capability holder (the buyer id).
- `REFUSAL` body `{ code, message, details?, intent_sha256 }`, plus `refusalResponseSchema` (`ok: false` + body) and `acceptanceSchema` (`{ ok: true, cap_id? }`) for the `POST /v0/messages` answer.
- Block code `CHILD_OUTLIVES_PARENT` (`{child_expires_at}`, `{parent_expires_at}`) replaces the `PARENT_MISMATCH` fallback; the engine must be switched by the main session.
**Consequences:** 25 block codes. Envelopes need a `task_id`, so the buyer must mint one before the intent.
- UI events (not covered by PROTOCOL_VERSION): `BUDGET_UPDATED {cap_id, remaining, reserved, committed}` added, `UI_EVENTS_VERSION` 0.2.0.

### ADR-026 — Buyer identity (ed25519), principal key never in the buyer process
**Decision (2026-10-10):** `keys:init` adds role `buyer`, an ed25519 key (`keys/buyer.key`, `ed25519:<hex>` in identities.json). It is the holder of the child capability and signs SPEND_INTENT. The buyer-agent loads only `identities.json` and `keys/buyer.key`; it never reads `keys/principal.key` (only the principal-signing path in the engine/UI host does, for the root mandate).
**Consequences:** a compromised planner can sign intents only within the child capability; it cannot mint or widen a mandate (invariants 1, 2).

### ADR-025 — Protocol 0.1.2 (additive)
**Decision (human-approved 2026-10-10):** `PROTOCOL_VERSION = "0.1.2"`. Wire version unchanged.
- `allowed_payees: PublicId[]` (min 1, required, fail closed) on root and child capabilities. The engine enforces on `allowed_payees`; `counterparties` stays for wire compatibility and is legacy.
- Attenuation: `payeesAttenuate(parent, child)` (child payees must be a subset of the parent's) and block code `PAYEE_NOT_IN_PARENT` (`{payee}`).
**Consequences:** 26 block codes. Capability issuers and fixtures must now set `allowed_payees`.

### ADR-027 — Principal key lives only in `apps/principal-signer`
**Decision (2026-10-10):** the Principal EIP-191 key is loaded by `apps/principal-signer` (Fastify on 127.0.0.1:7403, `POST /sign-root`) and nowhere else. The demo-ui calls it after the approve click; the engine only knows the Principal public id (identities.json) and verifies roots on `POST /api/mandate`. `POST /api/principal/sign-root` and the principal seed loading are removed from the engine. Hard limits (`ROOT_OVER_HARD_LIMIT`) and the network asset id (`network.json`) are enforced at registration, not at signing.
**Consequences:** an engine host compromise cannot mint a mandate (invariants 1, 2). `@tetherto/wdk-wallet-evm` stays in the engine only for the engine's own key. `ROOT_OVER_HARD_LIMIT`, `SECOND_CONFIRM_REQUIRED`, `UI_ONLY` are local UI codes outside the protocol catalogue and never appear in a REFUSAL.

### ADR-028 — Protocol 0.1.3 (additive): `intent_sha256` in the Task Contract
**Decision (human-approved 2026-10-11, step P3.2):** `PROTOCOL_VERSION = "0.1.3"`. The Task Contract gains required `intent_sha256: hex32` in `contractBase` (covered by both signatures, `contractHash` and `taskId`). Value: `hashObj({ cap_hash, intent })` of the SPEND_INTENT body the contract fulfils (the engine's `intentSha`).
**Consequences:** contract hash and task id change (golden vectors updated); every contract builder must set the field; the contract is cryptographically bound to the intent that authorised it.

### ADR-029 — What the contract's `package_sha256` covers, and a keys/peers package split
**Decision (2026-10-11, step P3.6a):** no protocol change and no version bump. `contract.verifier.package_sha256` keeps its name and its meaning (directory hash of the verifier package). After P3.5 that package contains the judge, executor entry, `manifest.json` (timeouts, output cap), schema, inputs and expected outputs, so the hash commits to all of them. The worker now refuses an offer whose hash differs from its own copy of the package; its self-check already ran through the same runner and package. OS-level sandbox limits live in verifier code and are not hashed.
Also: keys, identities, data dir, EIP-191 and the new `peers.ts` moved from `@verdict/wallet` to `@verdict/identity` (wallet re-exports it), so the Mac verifier installs with `pnpm install --filter "@verdict/verifier..."` without `@utexo/rgb-lightning-node-nodejs` (Rust build) or `@qvac/sdk`.
**Consequences:** a verifier on another machine with a different package is refused by both worker and verifier before money moves.
