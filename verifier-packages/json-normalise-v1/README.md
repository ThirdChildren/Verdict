# json-normalise-v1

Task: read a messy JSON file (`argv[2]`), print canonical JSON: keys sorted recursively (code-unit order), arrays in
input order, strings unchanged, numbers in plain decimal (no exponent, no trailing zeros, -0 as 0), 2-space indent,
trailing newline. Format-2 package: entry `normalise.mjs`, judged by the generic `verify.mjs`
(`verifier-packages/_judge/README.md`).

## Checks (standard profile, min score 80)

| check | kind | weight | required |
| --- | --- | --- | --- |
| fixtures (8 hidden cases) | fixtures | 50 | yes |
| visible (3 shown cases) | fixtures | 10 | no |
| schema (output is an object) | schema | 15 | yes |
| idempotent (`case-keys` vs `case-keys-shuffled`) | property | 10 | no |
| static (no network modules, `fetch`, `import(`, `eval`) | static | 0 | yes |
| limits (20000 bytes, 300 lines) | limits | 5 | no |
| spec (`spec/assertions.json`) | spec | 10 | yes |

Passing every required check but failing visible, idempotent and limits scores 75, below the standard min of 80, so it is FAIL.

Profiles: `strict` (min 95, visible and idempotent required, full determinism), `standard` (min 80), `lenient`
(min 60, schema not required, whitespace collapsed). Pick one with `profile` in `manifest.json`.

## Limits of the judge here

Fixtures and visible use `compare: "text"` with `whitespace: "trim-lines"`: output must match the expected text
exactly (key order, number spelling, indentation) apart from trailing spaces on lines and the number of trailing newlines; profile tolerances do not apply
in text mode. Judge sha256 `5587078593b9ef1d31324cf9ac7e6295d168958c4629f3d08dfb896ad55d8933`. `spec` forbids `NaN`, `Infinity`, `undefined` and caps output size.
`schema` cannot express "object or array", so it requires an object. Avoid integer-like keys in new cases (parsing
re-orders them).

## Run

    pnpm verifier:rerun -- <bundle> verifier-packages/json-normalise-v1
    sh verifier-packages/json-normalise-v1/verify.sh verifier-packages/json-normalise-v1/fixtures/good-delivery

`fixtures/good-delivery` scores 100; `fixtures/bad-delivery` (sorts only top-level keys) fails only `fixtures`.

The package hash covers this README, so it is not written here: print it with `pnpm verifier:hash`.
