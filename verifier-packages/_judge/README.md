# Generic judge for format-2 verifier packages

`verify.mjs` is one file, copied verbatim into every format-2 package and pinned by `judge_sha256` in that package's
`manifest.json`. The runner refuses a format-2 package whose `judge_sha256` is not the hash of this file (or listed in
`VERIFIER_JUDGE_ALLOW`). Node built-ins only; no clock, no randomness, no network. It never loads delivery code.

    node verify.mjs <delivery_dir> <out_dir>

It reads `manifest.json` next to itself. Output: one JSON line per check
`{"id","status","required","weight","ms"}` (`ms` is always 0: the judge has no clock, so its output is byte-identical on
every run), then `{"id":"_verdict","status","score","min_score","profile"}`. Exit 0 iff the verdict is `pass`.

Verdict: `score = 100 * sum(weight of passed) / sum(weight)` (two decimals; all weights 0 gives 100 or 0). PASS iff every
effectively required check passed and `score >= min_score`. A check is effectively required if
`profiles[profile].required_overrides[id]` says so, else its own `required`. Profile `tolerances` are merged over each
check's `params`. Profile `determinism` is `judge` (runner runs the judge twice) or `full` (also re-runs the executor).

Executor outputs are `<stem><output_ext>` for each `cases_dir` input; the runner also runs `visible_dir` inputs and names
their outputs `v__<stem><output_ext>`. Expected files are `<stem><expected_ext>` next to the input.

## Check kinds

| kind | params |
| --- | --- |
| `fixtures` (also `differential`) | `cases_dir` (default the manifest's; use `visible_dir` for shown cases), `key_order` (`insensitive`, else significant), `whitespace` (`trim-lines` or `collapse`, for strings), `numeric_tolerance` `{rel, abs}` |
| `schema` | `file` (default `schema.json`), `cases_dir`. Subset validator: `type`, `items`, `properties`, `required`, `additionalProperties` |
| `property` | `same_output`: list of `[caseA, caseB]` stems whose outputs must be equal under the same normalisation |
| `static` | `banned_imports` (module names, `node:` prefix ignored), `banned_tokens`; scans every `.js/.mjs/.cjs` of the delivery; the entry file must exist |
| `limits` | `max_source_bytes`, `max_lines` over the delivery's JS files |
| `spec` | `file` (default `spec/assertions.json`): see below |

## spec assertions

`assertions.json` is an object; every key must be one of these (an unknown key fails the check, so a typo cannot
silently weaken the rules). All are evaluated on every hidden case.

- `output_keys_required`: list of keys; the output object (or each object of a top-level array) has them all.
- `max_output_bytes`: number; every output is at most that many bytes.
- `numbers_subset_of_input`: `true`; every number in the output also appears, by value, in that case's input.
- `required_tokens` / `forbidden_tokens`: lists of strings the output text must / must not contain.
