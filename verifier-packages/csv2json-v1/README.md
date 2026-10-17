# csv2json-v1

Deterministic verifier package. Two roles: the executor runs `<delivery_dir>/csv2json.mjs` per case (the verifier does this inside its sandbox, with only `cases/*.csv` and one output dir visible); the judge `verify.mjs <delivery_dir> <out_dir>` never loads delivery code, reads the outputs as size-limited data and
prints one JSON line per check (`{"id","status"}`, status `pass` or `fail`). Exit 0 only if all pass.

- `tests`: every `cases/*.csv` must convert to `cases/*.expected.json` (deep equal).
- `schema`: every output validates against `schema.json` (hand-written validator, no dependencies).
- `no-network`: static scan for network / process imports and `fetch`.

`fixtures/good-delivery` passes all checks; `fixtures/bad-delivery` fails exactly `tests` (refund demo).
Zero npm dependencies; Node built-ins only. Package hash: `pnpm verifier:hash`.

`verify.sh <delivery_dir>` is the unsandboxed local self-check (execute.mjs, then verify.mjs). `manifest.json` tells the verifier how to run each case.
