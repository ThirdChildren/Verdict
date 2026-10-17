// Test helper: a tiny format-2 package ("sort-json": sort object keys, print with 2-space indent) that uses the real
// generic judge. Not imported by production code.
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GENERIC_JUDGE_PATH, genericJudgeSha256, type ManifestV2 } from "./manifest.js";

export const SORT_SOURCE = `import { readFileSync } from "node:fs";
const sort = (v) =>
  Array.isArray(v) ? v.map(sort)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]))
  : v;
process.stdout.write(JSON.stringify(sort(JSON.parse(readFileSync(process.argv[2], "utf8"))), null, 2));
`;

export const sortJson = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortJson)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sortJson((v as Record<string, unknown>)[k])]),
        )
      : v;

export const pretty = (v: unknown): string => JSON.stringify(sortJson(v), null, 2);

export const CASES: Record<string, unknown> = {
  a: { b: 1, a: 2 },
  "a-shuffled": { a: 2, b: 1 },
  b: { z: [3, 1], y: "x" },
};
export const VISIBLE: Record<string, unknown> = { v1: { q: 1, p: { n: 2, m: 3 } } };

export function baseManifest(): ManifestV2 {
  return {
    format: 2,
    id: "sort-json-test",
    description: "Sort object keys.",
    profile: "standard",
    entry: "sort.mjs",
    cases_dir: "cases",
    visible_dir: "visible",
    input_ext: ".json",
    expected_ext: ".expected.json",
    output_ext: ".out.json",
    case_timeout_seconds: 10,
    max_output_bytes: 1048576,
    judge_sha256: genericJudgeSha256() as string,
    checks: [
      {
        id: "fixtures",
        kind: "fixtures",
        weight: 50,
        required: true,
        params: { key_order: "insensitive" },
      },
      {
        id: "visible",
        kind: "fixtures",
        weight: 10,
        required: false,
        params: { cases_dir: "visible" },
      },
      { id: "schema", kind: "schema", weight: 15, required: true, params: { file: "schema.json" } },
      {
        id: "idempotent",
        kind: "property",
        weight: 10,
        required: false,
        params: { same_output: [["a", "a-shuffled"]] },
      },
      {
        id: "no-network",
        kind: "static",
        weight: 0,
        required: true,
        params: {
          banned_imports: ["net", "http", "child_process"],
          banned_tokens: ["fetch", "import("],
        },
      },
      {
        id: "size",
        kind: "limits",
        weight: 5,
        required: false,
        params: { max_source_bytes: 20000, max_lines: 300 },
      },
      {
        id: "request",
        kind: "spec",
        weight: 10,
        required: true,
        params: { file: "spec/assertions.json" },
      },
    ],
    profiles: {
      strict: {
        min_score: 95,
        required_overrides: { visible: true, idempotent: true },
        tolerances: { numeric_tolerance: { rel: 0 }, key_order: "significant" },
        determinism: "full",
      },
      standard: { min_score: 80, required_overrides: {}, tolerances: {}, determinism: "judge" },
      lenient: {
        min_score: 60,
        required_overrides: { schema: false },
        tolerances: { whitespace: "collapse" },
        determinism: "judge",
      },
    },
  };
}

export interface V2Options {
  mutate?: (m: ManifestV2) => void;
  /** Replaces verify.mjs (a different judge). */
  judgeSource?: string;
  assertions?: Record<string, unknown>;
  /** Replaces schema.json. */
  schema?: Record<string, unknown>;
}

/** Writes the package to `<root>/<name>` and returns its path. */
export function makeV2Package(root: string, name: string, opts: V2Options = {}): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "cases"), { recursive: true });
  mkdirSync(join(dir, "visible"), { recursive: true });
  mkdirSync(join(dir, "spec"), { recursive: true });
  const m = baseManifest();
  opts.mutate?.(m);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2));
  if (opts.judgeSource !== undefined) writeFileSync(join(dir, "verify.mjs"), opts.judgeSource);
  else cpSync(GENERIC_JUDGE_PATH, join(dir, "verify.mjs"));
  writeFileSync(
    join(dir, "schema.json"),
    JSON.stringify(
      opts.schema ?? { type: "object", properties: { a: { type: "number" } }, required: [] },
    ),
  );
  writeFileSync(
    join(dir, "spec/assertions.json"),
    JSON.stringify(opts.assertions ?? { max_output_bytes: 4096, numbers_subset_of_input: true }),
  );
  for (const [k, v] of Object.entries(CASES)) {
    writeFileSync(join(dir, "cases", `${k}.json`), JSON.stringify(v));
    writeFileSync(join(dir, "cases", `${k}.expected.json`), pretty(v));
  }
  for (const [k, v] of Object.entries(VISIBLE)) {
    writeFileSync(join(dir, "visible", `${k}.json`), JSON.stringify(v));
    writeFileSync(join(dir, "visible", `${k}.expected.json`), pretty(v));
  }
  return dir;
}

/** A delivery directory holding sort.mjs (or another entry source). */
export function makeDelivery(root: string, name: string, source = SORT_SOURCE): string {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "sort.mjs"), source);
  return d;
}

/** An executor out dir as the runner would leave it, with `render` applied to every case (hidden: stem, visible: v__stem). */
export function makeOutputs(
  root: string,
  name: string,
  render: (stem: string, value: unknown, visible: boolean) => string | null = (_s, v) => pretty(v),
): string {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries(CASES)) {
    const t = render(k, v, false);
    if (t !== null) writeFileSync(join(d, `${k}.out.json`), t);
  }
  for (const [k, v] of Object.entries(VISIBLE)) {
    const t = render(k, v, true);
    if (t !== null) writeFileSync(join(d, `v__${k}.out.json`), t);
  }
  return d;
}
