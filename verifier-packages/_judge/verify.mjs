// Generic format-2 judge. Node built-ins only. Deterministic: no clock, no randomness, no network.
// It NEVER loads or runs delivery code. It reads the outputs the executor left in <out_dir> (plain data,
// size-limited, symlinks refused), the expected files and parameters that live only in this package
// (manifest.json next to this file), and the delivery sources as text.
// Usage: node verify.mjs <delivery_dir> <out_dir>
// Output: one JSON line per check {"id","status","required","weight","ms"} then
//         {"id":"_verdict","status","score","min_score","profile"}. Exit 0 iff the verdict is pass.
// `ms` is always 0: the judge has no clock, so that its output is byte-identical on every run.
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const delivery = resolve(process.argv[2] ?? "");
const outDir = resolve(process.argv[3] ?? "");
const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
const MAX_OUT = manifest.max_output_bytes;
const VISIBLE_PREFIX = "v__";
const isJson = (ext) => ext.endsWith(".json");

// ---------- reading ----------

/** Reads one executor output as data: regular file, not a symlink, at most MAX_OUT bytes. */
function readData(p, asJson) {
  try {
    if (!lstatSync(p).isFile()) return { ok: false };
    const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > MAX_OUT) return { ok: false };
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const n = readSync(fd, buf, off, st.size - off, off);
        if (n === 0) break;
        off += n;
      }
      const text = buf.subarray(0, off).toString("utf8");
      return { ok: true, text, value: asJson ? JSON.parse(text) : text };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { ok: false };
  }
}

/** Stems of the cases in a package dir ("cases" hidden, or the visible dir). */
function stemsOf(dirName) {
  const d = join(here, dirName);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith(manifest.input_ext) && !f.endsWith(manifest.expected_ext))
    .map((f) => f.slice(0, -manifest.input_ext.length))
    .sort();
}
const isVisible = (dirName) =>
  manifest.visible_dir !== undefined && dirName === manifest.visible_dir;
const outputOf = (dirName, stem) =>
  readData(
    join(outDir, `${isVisible(dirName) ? VISIBLE_PREFIX : ""}${stem}${manifest.output_ext}`),
    isJson(manifest.output_ext),
  );
const expectedOf = (dirName, stem) =>
  readData(join(here, dirName, `${stem}${manifest.expected_ext}`), isJson(manifest.expected_ext));

// ---------- normalisation and comparison ----------

function normText(s, whitespace) {
  if (whitespace === "trim-lines")
    return s
      .split(/\r?\n/)
      .map((l) => l.trim())
      .join("\n")
      .trim();
  if (whitespace === "collapse") return s.replace(/\s+/g, " ").trim();
  return s;
}

function numEq(a, b, tol) {
  if (a === b) return true;
  const rel = tol?.rel ?? 0;
  const abs = tol?.abs ?? 0;
  return Math.abs(a - b) <= Math.max(rel * Math.abs(b), abs);
}

/** Equality under the declared normalisation: key_order, whitespace, numeric_tolerance. */
function same(a, b, p) {
  if (typeof a === "string" && typeof b === "string")
    return normText(a, p.whitespace) === normText(b, p.whitespace);
  if (typeof a === "number" && typeof b === "number") return numEq(a, b, p.numeric_tolerance);
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => same(x, b[i], p));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  if (p.key_order === "insensitive")
    return ka.every((k) => Object.hasOwn(b, k) && same(a[k], b[k], p));
  return ka.every((k, i) => k === kb[i] && same(a[k], b[k], p));
}

const sameOutput = (a, b, p) =>
  isJson(manifest.output_ext)
    ? same(a, b, p)
    : normText(String(a), p.whitespace) === normText(String(b), p.whitespace);

// ---------- schema (copy of the csv2json-v1 subset validator: type, items, properties, required, additionalProperties) ----------

function validate(s, v) {
  if (s.type !== undefined) {
    const t = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
    if (t !== s.type) return false;
  }
  if (s.items && Array.isArray(v) && !v.every((x) => validate(s.items, x))) return false;
  if (s.type === "object") {
    const props = s.properties ?? {};
    for (const r of s.required ?? []) if (!(r in v)) return false;
    for (const [k, x] of Object.entries(v)) {
      if (k in props) {
        if (!validate(props[k], x)) return false;
      } else if (s.additionalProperties === false) return false;
      else if (typeof s.additionalProperties === "object" && !validate(s.additionalProperties, x))
        return false;
    }
  }
  return true;
}

// ---------- delivery sources ----------

function jsFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out.push(...jsFiles(p));
    else if (/\.(mjs|cjs|js)$/.test(n)) out.push(p);
  }
  return out;
}
const sources = () => jsFiles(delivery).map((f) => readFileSync(f, "utf8"));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function importsOf(banned) {
  const alt = banned.map((b) => escapeRe(b.replace(/^node:/, ""))).join("|");
  if (alt === "") return [];
  return [
    new RegExp(`\\bfrom\\s*["'](?:node:)?(?:${alt})(?:/[^"']*)?["']`),
    new RegExp(`\\bimport\\s*["'](?:node:)?(?:${alt})(?:/[^"']*)?["']`),
    new RegExp(`\\b(?:import|require)\\s*\\(\\s*["'](?:node:)?(?:${alt})(?:/[^"']*)?["']`),
  ];
}
function tokenRe(t) {
  const e = escapeRe(t);
  return new RegExp(`${/^\w/.test(t) ? "\\b" : ""}${e}${/\w$/.test(t) ? "\\b" : ""}`);
}

// ---------- spec assertions (closed vocabulary; an unknown key fails the check) ----------
// output_keys_required: every output object (or every object in a top-level array) has these keys
// max_output_bytes:     every output is at most N bytes
// numbers_subset_of_input: every number in an output also appears in that case's input (by value)
// required_tokens / forbidden_tokens: substrings every output must / must not contain

const NUMBER_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
const numbersIn = (text) => (text.match(NUMBER_RE) ?? []).map(Number);
const isStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

function hasKeys(value, keys) {
  const objs = Array.isArray(value) ? value : [value];
  return objs.every(
    (o) =>
      typeof o === "object" &&
      o !== null &&
      !Array.isArray(o) &&
      keys.every((k) => Object.hasOwn(o, k)),
  );
}

const SPEC_RULES = {
  output_keys_required: (keys, ctx) =>
    isStrings(keys) && ctx.every((c) => c.out.ok && hasKeys(c.out.value, keys)),
  max_output_bytes: (n, ctx) =>
    typeof n === "number" &&
    ctx.every((c) => c.out.ok && Buffer.byteLength(c.out.text, "utf8") <= n),
  numbers_subset_of_input: (on, ctx) =>
    typeof on === "boolean" &&
    (!on ||
      ctx.every((c) => {
        if (!c.out.ok || !c.input.ok) return false;
        const allowed = new Set(numbersIn(c.input.text));
        return numbersIn(c.out.text).every((x) => allowed.has(x));
      })),
  required_tokens: (toks, ctx) =>
    isStrings(toks) && ctx.every((c) => c.out.ok && toks.every((t) => c.out.text.includes(t))),
  forbidden_tokens: (toks, ctx) =>
    isStrings(toks) && ctx.every((c) => c.out.ok && toks.every((t) => !c.out.text.includes(t))),
};

// ---------- profile ----------

const profile = manifest.profiles?.[manifest.profile];

// Same floor as the runner's manifest validator, so both reject the same manifests.
function manifestProblem() {
  if (profile === undefined || !Array.isArray(manifest.checks) || manifest.checks.length === 0)
    return "unknown profile or no checks";
  for (const c of manifest.checks)
    if (!Number.isInteger(c.weight) || c.weight < 0 || c.weight > 1000)
      return `bad weight on ${c.id}`;
  for (const [name, p] of Object.entries(manifest.profiles)) {
    if (!Number.isInteger(p.min_score) || p.min_score < 1 || p.min_score > 100)
      return `profile ${name}: min_score must be an integer in [1, 100]`;
    for (const key of ["file", "cases_dir"])
      if (p.tolerances && key in p.tolerances)
        return `profile ${name}: tolerances may not set ${key}`;
    const req = (c) => p.required_overrides?.[c.id] ?? c.required;
    if (
      !manifest.checks.some(
        (c) => ["fixtures", "schema", "differential"].includes(c.kind) && req(c),
      )
    )
      return `profile ${name}: no required fixtures, schema or differential check`;
    if (manifest.checks.some((c) => c.kind === "static" && !req(c)))
      return `profile ${name}: a static check is not required`;
  }
  return null;
}
const problem = manifestProblem();
if (problem !== null) {
  process.stdout.write(
    `${JSON.stringify({ id: "_verdict", status: "fail", score: 0, min_score: 0, profile: String(manifest.profile), error: problem })}\n`,
  );
  process.exit(1);
}
const minScore = profile.min_score;

function paramsOf(check) {
  return { ...(check.params ?? {}), ...(profile.tolerances ?? {}) };
}

// ---------- check kinds ----------

function fixturesPass(params) {
  const dirName = params.cases_dir ?? manifest.cases_dir;
  const stems = stemsOf(dirName);
  if (stems.length === 0) return false;
  return stems.every((s) => {
    const o = outputOf(dirName, s);
    const e = expectedOf(dirName, s);
    return o.ok && e.ok && sameOutput(o.value, e.value, params);
  });
}

function schemaPass(params) {
  const sch = readData(join(here, params.file ?? "schema.json"), true);
  if (!sch.ok) return false;
  const dirName = params.cases_dir ?? manifest.cases_dir;
  const stems = stemsOf(dirName);
  return (
    stems.length > 0 &&
    stems.every((s) => {
      const o = outputOf(dirName, s);
      return o.ok && validate(sch.value, o.value);
    })
  );
}

function propertyPass(params) {
  const pairs = params.same_output;
  if (!Array.isArray(pairs) || pairs.length === 0) return false;
  return pairs.every((pr) => {
    if (!Array.isArray(pr) || pr.length !== 2) return false;
    const a = outputOf(manifest.cases_dir, pr[0]);
    const b = outputOf(manifest.cases_dir, pr[1]);
    return a.ok && b.ok && sameOutput(a.value, b.value, params);
  });
}

function staticPass(params) {
  if (!existsSync(join(delivery, manifest.entry))) return false;
  const imps = importsOf(params.banned_imports ?? []);
  const toks = (params.banned_tokens ?? []).map(tokenRe);
  return sources().every(
    (src) => !imps.some((re) => re.test(src)) && !toks.some((re) => re.test(src)),
  );
}

function limitsPass(params) {
  if (!existsSync(join(delivery, manifest.entry))) return false;
  const files = jsFiles(delivery);
  const bytes = files.reduce((n, f) => n + statSync(f).size, 0);
  const lines = sources().reduce((n, s) => n + s.split("\n").length, 0);
  return (
    (params.max_source_bytes === undefined || bytes <= params.max_source_bytes) &&
    (params.max_lines === undefined || lines <= params.max_lines)
  );
}

function specPass(params) {
  const f = readData(join(here, params.file ?? "spec/assertions.json"), true);
  if (!f.ok || typeof f.value !== "object" || f.value === null || Array.isArray(f.value))
    return false;
  const entries = Object.entries(f.value);
  if (entries.length === 0) return false;
  const stems = stemsOf(manifest.cases_dir);
  if (stems.length === 0) return false;
  const ctx = stems.map((s) => ({
    out: outputOf(manifest.cases_dir, s),
    input: readData(join(here, manifest.cases_dir, `${s}${manifest.input_ext}`), false),
  }));
  return entries.every(([k, v]) => Object.hasOwn(SPEC_RULES, k) && SPEC_RULES[k](v, ctx));
}

const KINDS = {
  fixtures: fixturesPass,
  differential: fixturesPass,
  schema: schemaPass,
  property: propertyPass,
  static: staticPass,
  limits: limitsPass,
  spec: specPass,
};

function runCheck(check) {
  try {
    const fn = KINDS[check.kind];
    return fn !== undefined && fn(paramsOf(check)) === true;
  } catch {
    return false;
  }
}

// ---------- run ----------

const lines = [];
let weightAll = 0;
let weightPass = 0;
let requiredOk = true;
let allPass = true;
for (const check of manifest.checks) {
  const ok = runCheck(check);
  const required = profile.required_overrides?.[check.id] ?? check.required;
  weightAll += check.weight;
  if (ok) weightPass += check.weight;
  else {
    allPass = false;
    if (required) requiredOk = false;
  }
  lines.push({ id: check.id, status: ok ? "pass" : "fail", required, weight: check.weight, ms: 0 });
}
const score =
  weightAll === 0 ? (allPass ? 100 : 0) : Math.round((10000 * weightPass) / weightAll) / 100;
const pass = requiredOk && score >= minScore;
for (const l of lines) process.stdout.write(`${JSON.stringify(l)}\n`);
process.stdout.write(
  `${JSON.stringify({ id: "_verdict", status: pass ? "pass" : "fail", score, min_score: minScore, profile: manifest.profile })}\n`,
);
process.exit(pass ? 0 : 1);
