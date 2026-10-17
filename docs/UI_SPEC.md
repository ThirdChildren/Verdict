# demo-ui specification (story-first projector UI)

Rebuild recipe for the event. Stack (ADR-012): Vite, React 19, TS strict, Tailwind v4, shadcn/ui on
the `radix-ui` umbrella, sonner, motion (`motion/react`), TanStack Query, React Hook Form + zod,
Zustand (WebSocket event stream only), lucide-react. Versions and install facts: `docs/SDK_NOTES.md`.
Types come from `@verdict/protocol`. Principle: one focal point at a time, technical detail on demand,
no client-side money math (every amount shown is a string from the engine).

## Libraries and where they are used
- `src/components/ui/*`: shadcn primitives (button, card, badge, dialog, sheet, tabs, tooltip, switch,
  progress, scroll-area, separator, skeleton, kbd, input, label, checkbox, alert) plus hand-written
  `sonner.tsx`. Generated with `pnpm dlx shadcn@4.21.4 add <name> -y`; afterwards re-pin any dependency the
  CLI added (it once added an unpinned `cn`) and repoint `from "cn"` to `@/lib/utils`. Sizes are bumped to
  16px base text. Alias `@/` = `src/` (vite, tsconfig, root vitest config).
- Theme: `ThemeProvider` toggles `dark` on `<html>`, so portalled dialogs, sheets and toasts follow it.
  Tokens in `index.css` (`--background`, `--card`, `--primary`, plus `info-*` blue, `warn-*` amber, `ok-*` green,
  `danger-*` red). Light high-contrast by default; choice persisted in localStorage.
- Motion: `MotionConfig reducedMotion="user"` in `Providers`; used for the budget bar, the block ring and
  the step panel cross-fade. CSS transitions are also cut by `prefers-reduced-motion`.
- TanStack Query (`lib/queries.ts`): tasks (`GET /api/tasks`, descriptions), active mandate
  (`/api/mandate/active`), chain height (poll 2 s while funds are locked), evidence, verifier log tail;
  mutations: propose mandate, sign mandate, start task, attack. Zustand holds the WS events (state plus a capped raw event log for the Inspector) and selection.
- Forms: new task (`NewTaskButton`) and the mandate wizard's text step use react-hook-form + `zodResolver`.
- Toasts: `sonner`; blocked requests raise a red toast (`lib/notify.ts`), success/error toasts on forms.

## Visual rubric (scored on every 1280x720 light screenshot; `pnpm ui:shots`)
Run `pnpm ui:shots`, open `.logs/shots/<scene>-1280x720-light.png`, score, fix every miss. Never claim a visual change you have not looked at.
1. Focal point obvious within 3 s; only the stage draws the eye, rail and header stay quiet.
2. At most 3 visible regions (header, rail, stage); inspector closed by default.
3. Exactly one primary button visible at a time (New task is outline while there is no mandate).
4. Type scale only 13/14/16/20/28/40 px and two weights (400, 600); enforced by tokens in `index.css` (`--text-*`, `--font-weight-*`). Body >=14px, stage text >=16px.
5. Spacing on an 8px grid; no card inside a card; borders 1px, low contrast; generous whitespace.
6. Colour: neutral greys + ONE accent (blue, buttons/focus/"now") + semantic colours only: amber = locked/reserved, green = paid, blue = refunded/released (PASS), red = blocked/failed. Always icon + word. This supersedes the older "blue = progress/paid, amber = blocked" wording.
7. No raw ids, hashes or JSON on the stage (Details only). Exception: the live worker output block.
8. Nothing clipped, overlapping or badly wrapping; stepper in one row at 1280px.
9. Budget meter is the only strong element in the header, with big (28px) numbers.

## Layout (app is `h-screen`, no page scroll, columns scroll on their own)
- `>=1280px`: rail 16rem, stage flex, inspector 21.5rem (closed by default, "Details" or `i` toggles). All sizes are rem, so presenter size scales everything.
- `<1280px`: inspector is a right `Sheet`.
- Top bar (one row): mark + `regtest · tUSD` text, budget meter (big numbers), mandate button (opens summary dialog),
  one `Services n/3` pill (`ServicesPill`: engine, worker, verifier; tooltip lists each service and its state; turns red and names the failing service, with a Reconnect button; amber while connecting), icon buttons for presenter size, shortcut help, theme and Details.
- Budget meter: Paid (committed), Locked (reserved), Left (remaining) with icon, word and number; widths use
  only the three engine numbers.

## Task rail
`New task` opens a dialog (description, amount; ceiling = engine-reported remaining). Rows (task or blocked
attempt, newest on top): `#n`, description, amount, status chip (Working, Locked, Verifying, Refund pending, Paid, Refunded,
Expired, Blocked; icon + word). Selection drives the stage; new task or block auto-selects. The rail has no footer: the attack lives only in the demo console.
The description of every task comes from the engine (`task.spec` of the signed contract), also after reload;
until the list arrives a row shows `Task <short id>`.

## Stage
Header (task #, description, amount, worker). Five steps: 1 Authorized, 2 Funds locked, 3 Work, 4 Verify,
5 Settled / Refunded / Expired; each with icon, label, machine, state word (Waiting/Now/Done/FAIL/Waiting for refund/Returned),
time. Machine labels (`lib/machines.ts`) come from the configured service hosts (`?engine=`, `?worker=`, `?verifier=`, `VITE_*_HOST`), the same peers the engine uses: a service on the engine's host is "This computer", another host shows its name or address; optional friendly names via `VITE_HOST_NAMES="192.168.1.20=Mac"`. No host name is hard-coded.
One plain-language caption (`lib/captions.ts`) in an `aria-live="polite"` region (screen-reader only once paid). All stage text is >= 16px. Active step expands:
Work = live token stream (muted surface, 180px, auto-scroll, fade at top; tok/s and `attempt n/3` in its header, never the block ring); Verify = big PASS/FAIL, checks, exit code (package hash and log tail live in Details);
Settled = green outcome card `Paid 1.20 tUSD to <worker> · verified PASS · <s> s` with a mono preview of the delivered output (from the evidence), then one compact payment line (dot, word, time: Pending, Claimable, Succeeded green / Failed red).
FAIL is final in the MVP (no redelivery). After a FAIL verdict `VERDICT_WITHHOLD` the flow is Verify = FAIL (red), Settled = "Waiting for refund"; the task chip reads "Refund pending" (amber), never "Verifying". Normal case (honest worker cancels): Settled goes straight to "Refunded" with a blue card `Refunded 1.20 tUSD to you · verified FAIL · <s> s`, no ring. The block ring is shown whenever the payment is held and no claim or cancel can be expected: (a) a FAIL verdict with the payment still held more than 10 s after it (`failAt`, `isHeld`; caption "The test failed. The worker did not cancel, so the money stays locked until the escrow deadline. Then it comes back to you."), or (b) the worker stopped responding. Ring text `37 of ~94 blocks` (blocks since the lock out of the blocks the lock lasts, arc proportional); the caption is the only "funds locked" sentence on the stage.

"Worker disappears": the worker accepts, the funds lock, and nothing ever comes back (no tokens, no delivery, no claim, no cancel, no verdict). The UI derives "stopped" client-side (`lib/stopped.ts`, `isWorkerStopped`): task in ESCROW_LOCKED, no streamed tokens for the task, and more than `WORKER_STOPPED_AFTER_MS` (20 s, override with `VITE_WORKER_STOPPED_AFTER_MS`) since the lock. A backend `worker_status: "stopped"` field is also accepted (`workerStoppedHint`, adapter only; the protocol schema strips unknown fields today). Then: Work = amber "Worker stopped responding", Verify = "Skipped — nothing delivered" (muted, no PASS/FAIL, no check list), Settle = "Waiting for refund" with the ring, the stage opens on Settle, the rail chip reads "Refund pending" (amber), and the one caption is "The worker vanished. The money stays locked until the escrow deadline, then comes back to you." If tokens or a delivery arrive later the state reverts on its own. Settled/Refunded/disappears scenes fit 1280x640 without scrolling (timeline line above the outcome card). There is no "cached fallback" badge.

## Blocked scene
Red alert on a flat tint (no shadow or texture): what the agent tried (only the fields that are known: amount, payee, category), the red catalogue message verbatim,
`Nothing was signed. No funds moved.`, `Your budget is unchanged: <left> tUSD left.`, reason code. A red toast is raised only when that blocked row is not already selected (new blocks auto-select, so normally the card is the notice). No bottom banner.

## Empty state (no mandate)
Three lines (permissions not wallets; lock, verify, pay on proof; blocked before signing) and `Create mandate`
(opens the mandate wizard), centred in the page. The task rail is hidden until a mandate exists, and the header shows only the `No mandate` pill (no budget text).

## Mandate wizard (`MandateWizard`)
Full-screen dialog (title, stepper and content share one left edge, max width 48rem), three steps with a stepper (Write, Review, Sign), react-hook-form + zod, motion slide between steps.
1. Write: textarea (min 3 characters) and two example chips. "Draft mandate" asks the buyer agent (`/api/goal`).
2. Review: big numbers for the ceiling and expiry, allowed workers (name, short id with copy) and category, `No recurring payments`.
   Amber alert for flags (an amount not in the user's text) and a checkbox that must be ticked before signing. If the signer
   itself answers HTTP 428 with a `confirm_token` (it re-checks the text, not the screen), the checkbox appears and the token is
   sent on the next approve (single use). A duration below `MIN_MANDATE_MINUTES` (2 h, what a task's lock window needs) shows
   "Too short for one task" and keeps Approve disabled. Raw JSON behind a disclosure. All checks stay server-side; the screen only explains them.
3. Sign: "Signed by the principal (separate process)", the signature and mandate id in short form with copy.
In `?mock=1` the wizard works against canned answers (`mock/api.ts`); nothing is signed.

## Inspector (`Inspector`, key `i`)
Right panel (sheet below 1280px), closed by default, shadcn Tabs.
- Proof: contract, delivery and verdict hashes recomputed in the browser (`HashCheck`, "verified in your browser"); "Who signed what" for
  Principal (mandate), Engine (task permission), Buyer (contract offer), Worker (contract accepted), Verifier (verdict), each with key and signature
  (`Hash`), or "Not signed yet". Live worker and verifier lanes below (not in mock).
- Events: raw messages for the selected task (plus the mandate and its task permission), newest first, expandable JSON, filter chips by sender role
  with counts. Role looks (icon, word, tint) are defined once in `lib/roles.ts` (`RoleBadge`).

## Demo console (`DemoConsole`, key `d`)
Bottom drawer (not a dialog, so `d` also closes it), hidden by default. It exists only when `GET /api/demo/toggles` answers `{enabled:true}`
(engine started with `VERDICT_DEMO_TOGGLES=1`; polled once a minute, any failure means hidden). Three columns:
- Worker switches: Sabotaged and Disappears, the worker's real state polled from `GET /v0/config` every 2 s, changed with `POST /v0/config`; "Worker not reachable" is shown instead of guessing.
- Compromised agent: `Simulate compromised agent` (same action as the rail button, live only).
- Mine until refund: `POST /api/demo/mine-until-refund {task_id}` for the selected task. Refusals are explained in plain language (`lib/mine.ts`: DEMO_LOCAL_ONLY, DEMO_BAD_REQUEST, DEMO_TASK_UNKNOWN, DEMO_ALREADY_MINING, DEMO_OTHER_PAYMENT_IN_FLIGHT).
Progress arrives on the engine socket as `DEMO_MINE_PROGRESS` (not in the frozen protocol; parsed in `lib/mine.ts` before the protocol parser), is stored in `mine[task_id]` and overrides the height and target of the block ring (`ringWithMining`).
In `?mock=1` the console is available with local canned switches and canned mining progress; the attack button is disabled ("Live only").

## Hashes
One component, `Hash`: mono, middle-truncated, full value in the title, copy button with a toast. Used for every hash, id and signature.

## Keyboard and accessibility
`n` new task, `j`/`k` next and previous task, `i` inspector, `m` mandate, `d` demo console (hook `lib/console.ts`: the console registers its toggle only when enabled), `p` presenter size, `t` theme, `?` help dialog (`ShortcutHelp`). Shortcuts ignored while typing or when a
dialog is open.
Presenter size: class `presenter` on `<html>` (persisted), 125% type from 1536px wide, 112.5% below; every type token is rem.
Motion: stage cross-fade per task, inspector slide, wizard step slide; all cut by `MotionConfig reducedMotion="user"`. Radix dialogs and sheets trap focus and restore it. 4px focus ring. Colour never alone: the semantic colours (see rubric) always come with an icon and a word. AA contrast in both themes.

## Mock mode `?mock=1`
`MOCK DATA` banner and a storyboard select (mandate expires in 11h 42m, inside the 24 h limit; block estimate = locked height + invoice delta 80 + margin 14, same formula as the engine; verifier shown on a second host) (`mock/storyboard.ts`): 1 No mandate, 2 Authorized, 3 Funds locked
+ working, 4 Verify FAIL, 5 Verify PASS, 6 Settled, 7 Verify FAIL then refunded (honest worker), 8 Refunded (never claimed), 9 Expired, 10 Worker disappears (stopped, Verify skipped, ring),
11 Blocked attempt, 12 Play recorded stream. Never available without `?mock=1`.

## Not yet in the UI
`Approve anyway` (Principal APPROVE) has no engine endpoint yet, so there is no button.

## Files
`App.tsx` · `store.ts` (reducer, selection, raw event log) · `lib/{mine,view,steps,captions,queries,notify,api,utils,roles,events,presenter,console}.ts` ·
`lib/machines.ts` · `components/{DemoConsole,TopBar,BudgetMeter,MandatePill,MandateSummary,MandateWizard,NewTaskButton,TaskRail,
StatusChip,Stage,StageStepper,StepPanels,PaymentTimeline,BlockedScene,BlockCard,EmptyState,Inspector,ProofTab,EventsTab,
RoleBadge,Hash,HashCheck,ShortcutHelp,MockBanner,Providers,ThemeProvider}.tsx` · `mock/storyboard.ts`.
`pnpm ui:shots` extras: mandate-wizard, wizard-review, wizard-review-flagged, wizard-signed, inspector, inspector-events, shortcut-help, presenter, console, console-mining, ring-mining.

Reference screenshots (1280x720, light, mock data): `docs/screenshots/` (07 = FAIL then refunded, 08 = Settled at 1280x640).
