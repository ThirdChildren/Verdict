// csv2json-v1 judge. Node built-ins only. Deterministic: no clock, no randomness, no network.
// It NEVER loads or runs delivery code. It compares the outputs the executor left in <out_dir> (plain data,
// size-limited, symlinks refused) with the expected files that live only in this package.
// Usage: node verify.mjs <delivery_dir> <out_dir>
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
const entry = join(delivery, manifest.entry);
const caseNames = readdirSync(join(here, manifest.cases_dir))
  .filter((f) => f.endsWith(manifest.input_ext))
  .map((f) => f.slice(0, -manifest.input_ext.length))
  .sort();
const schema = JSON.parse(readFileSync(join(here, "schema.json"), "utf8"));

/** Reads one executor output as data: regular file, not a symlink, at most MAX_OUT bytes. */
function readOutput(name) {
  const p = join(outDir, `${name}${manifest.output_ext}`);
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
      return { ok: true, value: JSON.parse(buf.subarray(0, off).toString("utf8")) };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { ok: false };
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  // Key order is significant for rows: columns must follow header order.
  return ka.every((k, i) => k === kb[i] && deepEqual(a[k], b[k]));
}

// Minimal JSON-schema subset: type, items, properties, required, additionalProperties.
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

const FORBIDDEN =
  "net|tls|http|https|http2|dgram|dns|child_process|cluster|worker_threads|inspector";
const PATTERNS = [
  new RegExp(`\\bfrom\\s*["'](?:node:)?(?:${FORBIDDEN})(?:/[^"']*)?["']`),
  new RegExp(`\\bimport\\s*["'](?:node:)?(?:${FORBIDDEN})(?:/[^"']*)?["']`),
  /\b(?:import|require)\s*\(/,
  /\bfetch\b/,
  /\bWebSocket\b|\bXMLHttpRequest\b|\bprocess\s*\.\s*binding\b|\bEventSource\b/,
];

function jsFiles(dir) {
  const out = [];
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...jsFiles(p));
    else if (/\.(mjs|cjs|js)$/.test(n)) out.push(p);
  }
  return out;
}

const results = [];
function report(id, ok) {
  results.push(ok);
  process.stdout.write(`${JSON.stringify({ id, status: ok ? "pass" : "fail" })}\n`);
}

const present = existsSync(entry);
const runs = present ? caseNames.map((n) => [n, readOutput(n)]) : [];
report(
  "tests",
  present &&
    runs.length > 0 &&
    runs.every(([n, r]) => {
      if (!r.ok) return false;
      const want = JSON.parse(
        readFileSync(join(here, manifest.cases_dir, `${n}${manifest.expected_ext}`), "utf8"),
      );
      return deepEqual(r.value, want);
    }),
);
report(
  "schema",
  present && runs.length > 0 && runs.every(([, r]) => r.ok && validate(schema, r.value)),
);
report(
  "no-network",
  present &&
    jsFiles(delivery).every(
      (f) =>
        statSync(f).size <= MAX_OUT && !PATTERNS.some((re) => re.test(readFileSync(f, "utf8"))),
    ),
);
process.exit(results.every(Boolean) ? 0 : 1);
