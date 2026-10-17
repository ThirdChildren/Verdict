# demo-ui specification (industrial projector UI)

An instrument panel printed on good paper: one ink, one paper, 1px rules, words instead of icons, no motion except the live token stream and progress rules. Behaviour, shortcuts and copy are unchanged from the story-first design; only the skin and layout differ. Binding directive: `workspace/features/E12-ui-industrial-directive.md`.

## Stack (what is imported)
React 19, Vite, Tailwind v4 (`@tailwindcss/vite`), Radix (`radix-ui`: focus trap, ESC, aria kept), TanStack Query v5 (REST mutations and polling), Zustand (`store.ts`, fed by engine, worker and verifier WebSockets), React Hook Form + zod.
shadcn primitives left in `components/ui`: `button` (default, outline), `checkbox`, `dialog`, `input`, `kbd`, `label`, `sheet`, `switch`, `tabs`, `tooltip`, `word-button`. No router.
`lucide-react`, `motion`, `sonner`, `tw-animate-css` are still declared in `package.json` but imported nowhere; removal needs a lockfile change (`pnpm remove` on the Legion).

## Tokens (`index.css`)
`--ink`, `--paper`, `--rule`, `--rule-soft`, `--muted` (secondary text), `--signal` (the single accent: primary action and focus identity only), `--surface` (selected row). Light is the default; `.dark` on `<html>` inverts the same tokens (no extra colours), AA contrast for muted on paper in both. Tailwind names: `text-ink bg-paper border-rule border-rule-soft text-subtle text-signal bg-surface`; shadcn aliases (`background`, `foreground`, `muted-foreground`, `primary`, `ring`) point at the same tokens. `--radius*` are 0, no shadows. Status is never a coloured fill.

## Type
System grotesk (`"IBM Plex Sans"`, Helvetica Neue, Helvetica, Arial) and mono (`"IBM Plex Mono"`, ui-monospace, Menlo). Two faces, weights 400 and 600, scale 13/14/16/20/28/40 px (base 16). `font-variant-numeric: tabular-nums` on body; every number, hash, id, amount and timestamp is mono. No font is fetched at runtime (the venue has no internet); see `public/fonts/FONTS.md` for self-hosting Plex.

## Glyphs and status words
Only typographic glyphs: ■ done or settled, □ waiting or lapsed, ▲ now or needs attention, › separator, × close. Status is an uppercase word with weight plus a glyph in ink (`StatusChip`, stepper). Words (text kept, CSS uppercase): Working, Locked, Verifying, Refund pending, Paid, Refunded, Expired, Blocked; steps: Done, Now, Waiting, Skipped, Returned, Needs attention; verdict PASS / FAIL.

## Layout (app is `h-screen`, no page scroll, columns scroll on their own)
- Header, one line (`TopBar`, `BudgetMeter`): `Verdict  regtest · tUSD  PAID 1.20 · LOCKED 0.00 · LEFT 3.80 / 5.00 tUSD`, a 4px rule under the ledger (ink = paid, grey = locked; `role="img"` with the same aria-label), mandate word (`MandatePill`: MANDATE · 11h left / NO MANDATE / MANDATE EXPIRED), `SERVICES 3/3` (bold plus `Reconnect` word when one is down), and the words Presenter · Help · Theme · Details.
- Left column `w-80`: `NEW TASK` button, then `TaskRail` rows: `#n` | title | amount (mono) with the status word on a second line; selected row has a 2px ink left rule and `--surface`.
- Main: `Stage` (task title, amount, worker), `StageStepper`, caption, step panel. Right: inspector (`i`).
- Stage ledger rows, one per step: `01  AUTHORIZED  ■ Done · 17:40:02  This computer · engine`; the current row has a 2px ink rule, waiting rows are muted, rows are buttons (`aria-current`, `aria-pressed`).
- Payment timeline, one mono line: `PENDING (LOCKED) 17:40:12 › CLAIMABLE 17:40:20 › SUCCEEDED 17:40:21` (unreached: `not yet`; Failed replaces Succeeded).
- Outcome blocks (`StepPanels`): ruled blocks, uppercase first line (`PAID 1.20 tUSD TO WORKER · VERIFIED PASS · 22 s`, `REFUNDED 1.20 tUSD TO YOU · VERIFIED FAIL`), delivered JSON preview in mono inside a 1px rule.
- Block ring (mine until refund, worker disappears): a progress rule plus `N of ~M blocks` in mono.
- Refusal: `BlockCard`/`BlockedScene`, `role="alert"`, 2px left ink rule, bold `BLOCKED: <title>`, catalogue message verbatim, `Nothing was signed. No funds moved.`, budget line, `Reason code: <CODE>` in mono. When a block arrives while its row is not selected, `BlockNotice` (`role="alert"`, Dismiss word) appears in place of a toast.
- Empty state: claim, three numbered lines, `Create mandate`.

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
