# demo-ui specification (soft instrument UI)

An instrument panel with depth: one ink, warm paper, square white cards with soft shadows (no rounded corners), `lucide-react` icons next to every status word, short ease-out motion (off under reduced motion). Behaviour, shortcuts and copy are unchanged from the story-first design; only the skin and layout differ.

## Stack (what is imported)
React 19, Vite, Tailwind v4 (`@tailwindcss/vite`), Radix (`radix-ui`: focus trap, ESC, aria kept), TanStack Query v5 (REST mutations and polling), Zustand (`store.ts`, fed by engine, worker and verifier WebSockets), React Hook Form + zod.
shadcn primitives left in `components/ui`: `button` (default, outline), `checkbox`, `dialog`, `input`, `kbd`, `label`, `sheet`, `switch`, `tabs`, `tooltip`, `word-button`. No router.
`lucide-react` supplies every icon (`Mark.tsx` for status marks, `ui/icon-button.tsx` for icon-only controls with a tooltip); `ui/dropdown-menu.tsx` is the Radix menu behind the header "More" button. `motion`, `sonner`, `tw-animate-css` are declared but imported nowhere.

## Tokens (`index.css`)
`--ink`, `--paper`, `--rule`, `--rule-soft`, `--muted` (secondary text), `--bitcoin` (#f7931a, Bitcoin orange: fills such as the primary button, brand mark and slider, always with dark text) and `--signal` (a darker orange, #b25a00 / #ffa94d in dark, for orange text and icons on cards), `--surface` (a warm orange tint for hover and the current step; boxes holding text are white cards, never grey). Light is the default; `.dark` on `<html>` inverts the same tokens (no extra colours), AA contrast for muted on paper in both. Tailwind names: `text-ink bg-paper border-rule border-rule-soft text-subtle text-signal bg-surface`; shadcn aliases (`background`, `foreground`, `muted-foreground`, `primary`, `ring`) point at the same tokens. Added for depth: `--card` (elevated white / dark card), `--ok`, `--warn`, `--bad` (status tints at 8-12 % for pills and notices, full strength only for icons and text, AA on card in both themes), `--sh-soft` and `--sh-lift` (`shadow-soft`, `shadow-lift`), all radii 0 (square boxes, square pills), a faint orange and green wash behind the page. Status is an icon plus a word, tinted but never colour alone. Motion: `animate-soft-in` (cards), `animate-drop-in` (dialogs), `animate-fade` (overlays, menus, tooltips).

## Type
System grotesk (`"IBM Plex Sans"`, Helvetica Neue, Helvetica, Arial) and mono (`"IBM Plex Mono"`, ui-monospace, Menlo). Two faces, weights 400 and 600, scale 13/14/16/20/28/40 px (base 16). `font-variant-numeric: tabular-nums` on body; every number, hash, id, amount and timestamp is mono. No font is fetched at runtime (the venue has no internet); see `public/fonts/FONTS.md` for self-hosting Plex.

## Marks and status words
Icons from `lucide-react` through `Mark.tsx`: done (check circle, green), now (spinner, orange), waiting (circle), skipped (minus), attention (triangle, amber), failed (x circle, red), blocked (shield alert, red), refunded (undo), expired (clock). A status is a soft pill (`StatusChip`) or a stepper row with the icon on the left and the word kept in the DOM (`Done`, `Now`, `Waiting`, `Needs attention`, `Returned`, `Expired`; task chips Working, Locked, Verifying, Refund pending, Paid, Refunded, Expired, Blocked; verdict PASS / FAIL). The icon is `aria-hidden`; the word carries the meaning.

## Layout (app is `h-screen`, no page scroll, columns scroll on their own)
- Header (`TopBar`, sticky, translucent with blur), one line in three groups. Left: brand mark, `Verdict`, `regtest · tUSD` badge (from 1440 px), the budget ledger (`PAID · LOCKED · LEFT` with a square 6 px bar: orange paid, amber locked), and the mandate pill (`Mandate · 11h41m left`, icon changes for retired and expired) with a `+` icon button (New mandate). Middle-right: the principal chip and the services pill (`3/3`, red and named when one is down, with a Reconnect word). Right, behind a divider: four icon buttons: Agents, Details, Theme, More. `More` is a menu holding Presenter size and Keyboard shortcuts. Icon buttons carry the old names as aria-labels and tooltips with the shortcut key.
- Left column `w-80`: `NEW TASK` button, then `TaskRail` rows: `#n` | title | amount (mono) with the status pill and amount chip on a second line; rows are square, hover lifts them onto a card, the selected one has an orange ring.
- Main: `Stage` (task title, amount, worker), `StageStepper`, caption, step panel. Right: inspector (`i`).
- Stage ledger rows, one per step: `01  AUTHORIZED  ■ Done · 17:40:02  This computer · engine`; the current row has a 2px ink rule, waiting rows are muted, rows are square cards with a status icon, buttons (`aria-current`, `aria-pressed`); the current one has an orange ring.
- Payment timeline, one mono line: `PENDING (LOCKED) 17:40:12 › CLAIMABLE 17:40:20 › SUCCEEDED 17:40:21` (unreached: `not yet`; Failed replaces Succeeded).
- Outcome blocks (`StepPanels`): ruled blocks, uppercase first line (`PAID 1.20 tUSD TO WORKER · VERIFIED PASS · 22 s`, `REFUNDED 1.20 tUSD TO YOU · VERIFIED FAIL`), delivered JSON preview in mono inside a 1px rule.
- Block ring (mine until refund, worker disappears): a progress rule plus `N of ~M blocks` in mono.
- Refusal: `BlockCard`/`BlockedScene`, `role="alert"`, 2px left ink rule, bold `BLOCKED: <title>`, catalogue message verbatim, `Nothing was signed. No funds moved.`, budget line, `Reason code: <CODE>` in mono. When a block arrives while its row is not selected, `BlockNotice` (`role="alert"`, Dismiss word) appears in place of a toast.
- Empty state: claim, three numbered lines, `Create mandate`.

## Principal and funds
Header word `CONNECT PRINCIPAL` (no wallet picker, no fake providers): it asks the engine (`GET /api/principal`, which asks the principal-signer's `/health`) for the principal's public id and shows the chip `Principal · WDK · eip191:0x…abcd · regtest` (id only below 1440 px). The connection is kept for the browser session (survives an event-stream reset and a reload). If the signer is down or holds another key the header says `▲ Principal unreachable · retry` and a ruled strip under it gives the engine's sentence. After connecting, a block `REGTEST TEST ASSET (TUSD)` at the top of the main column, to the right of the sidebar (not above it), shows `Spendable in channel` (buyer off-chain outbound), `Reserved by open tasks` (ledger reservations not yet committed) and `Available to delegate` (spendable minus reserved, floored at 0) from `GET /api/funds`, all decimal strings from the engine; it refetches on payment, budget, claim and refund events and every 15 s. Without a wallet the strip says so instead of a number.

In the mandate review, `SPENDING CEILING (TUSD)` is an amount input plus a slider (0 to available to delegate, one tUSD per step) and presets "N tasks of X" (N = 1, 3, 5, X = the per-task limit). The signed mandate carries the chosen ceiling; a ceiling below the per-task limit lowers the per-task limit to it. Above the available funds it only warns; signing is still allowed (the signer's hard limits are unchanged, and an amount that is not in the written goal still asks for the second confirmation). Without a connected principal there is no bound and no warning. Step 3 reads `Signed by your principal key (WDK, separate process)` with the short signature and a copy button.

## Mandates list

Above the task rail: one ruled row per mandate, newest first, `02 ■ ACTIVE 5.00 · 2.00/task · 9h11m left · 1 task`, `01 □ RETIRED 14:12 · 5.00 · 2 tasks`, `▲ EXPIRED`. The selected row carries the left rule; `[` and `]` move between mandates. Selection scopes the rail, the stage, the header ledger (frozen figures with `AT RETIREMENT hh:mm:ss` for a retired one) and the Agents panel; the header mandate word follows the selection. Retired and expired mandates disable NEW TASK with a one-sentence reason. Data: `GET /api/mandates` and `GET /api/tasks?mandate=`, parsed with Zod on connect, then live events (a new CAP_ROOT selects itself).

## Dialogs and panels
`ui/dialog.tsx` and `ui/sheet.tsx` are full-width panels ruled above and below (`Close ×` word); `className` styles the inner column. `MandateWizard`: text step indicator `1 WRITE › 2 REVIEW › 3 SIGN` (current bold), examples as underlined text buttons, Review as a two-column ruled ledger with mono numbers (ceiling, expiry, workers, category), raw JSON behind a disclosure, sticky footer with `Back` and `Approve and sign`, Sign step a ruled block. `MandateSummary`, `NewTaskButton`, `ShortcutHelp` are ruled two-column lists; shortcut keys use `kbd` in mono. In-place notices (`Note`) replace every toast.

## Inspector (`i`)
Tabs as underlined words. Proof: `■ CONTRACT  <hash> COPY  verified in your browser` rows (▲ and MISMATCH when different), signers list with uppercase mono role words (`RoleBadge`), then `WorkerLane` (live token stream, `Attempt n`, tokens/s in mono, sabotage and disappears checkboxes) and `VerifierLane` (PASS/FAIL line, check rows `■ id: passed`, sandbox, hashes, exit code, log tail), live mode only. Events: filter words, one row per message, raw JSON in a mono block with a 1px rule. `Hash` is the one component for hashes: mono, middle-truncated, full value in the title, `COPY` word that becomes `COPIED`.

## Demo console (`d`)
Bottom panel ruled above: worker switches, `Simulate compromised agent`, `Mine until refund` with the same progress rule. Results and errors are plain text in place.

## Keyboard and accessibility
`n` new task, `j`/`k` next and previous task, `i` inspector, `m` mandate, `d` demo console, `p` presenter size, `t` theme, `?` help. Ignored while typing or when a dialog is open.
Real `<button>`, `<input>` with `<label>`; `aria-live="polite"` on stage caption, ledger and verdict; `role="alert"` on refusals and errors; 2px ink `:focus-visible` outline; Radix traps and restores focus. Colour is never the only signal.
Presenter size: class `presenter` on `<html>` (persisted), 125% type from 1536px, 112.5% below; the header hides `regtest · tUSD` in this mode. Fit rule: header one line and Settled, Refunded and Worker-disappears scenes without scrolling at 1280x640.

## Mock mode `?mock=1`
A plain inverted `MOCK DATA: recorded sample. Nothing here is a real payment.` line plus a storyboard select (`mock/storyboard.ts`): 1 No mandate, 2 Authorized, 3 Funds locked + working, 4 Verify FAIL, 5 Verify PASS, 6 Settled, 7 FAIL then refunded, 8 Refunded, 9 Expired, 10 Worker disappears (ring), 11 Blocked attempt, 12 Play recorded stream. Never available without `?mock=1`.

## Not yet in the UI
`Approve anyway` (Principal APPROVE) has no engine endpoint yet, so there is no button.

## Screenshot loop
`QUICK=1 pnpm ui:shots [scene-id ...]` writes 1280x720 and 1280x640 light PNGs to `.logs/shots`; without `QUICK` it adds 1440x900 and dark (about 2.5 min). Extras: mandate-wizard, wizard-review, wizard-review-flagged, wizard-signed, inspector, inspector-events, shortcut-help, presenter, console, console-mining, ring-mining.
`docs/screenshots/`: 01-empty = `empty`, 02-mandate-wizard-review = `wizard-review`, 03-work-streaming = `working`, 04-pass-settled = `settled`, 05-blocked-scene = `blocked`, 06-worker-disappears = `ring`, 07-fail-refunded = `fail-refunded`, 08-settled-1280x640 = `settled` at 1280x640.

## Files
`App.tsx` · `store.ts` · `lib/{mine,view,steps,captions,queries,notify,api,roles,events,presenter,console,machines}.ts` · `components/{TopBar,BudgetMeter,MandatePill,ServicesPill,TaskRail,StatusChip,Stage,StageStepper,StepPanels,PaymentTimeline,BlockCard,BlockedScene,BlockNotice,Note,EmptyState,MandateWizard,MandateSummary,NewTaskButton,ShortcutHelp,DemoConsole,Inspector,ProofTab,EventsTab,RoleBadge,Hash,HashCheck,TaskIdCopy,WorkerLane,VerifierLane,MockBanner,Providers,ThemeProvider}.tsx` · `components/ui/*` · `mock/storyboard.ts` · `index.css` · `public/fonts/FONTS.md`.
