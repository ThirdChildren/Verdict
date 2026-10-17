// Local executor for the worker's self-check ONLY (verify.sh). The verifier never runs this file: it runs the delivery
// per case inside its own sandbox and calls verify.mjs afterwards.
// Usage: node execute.mjs <delivery_dir> <out_dir>
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const delivery = resolve(process.argv[2] ?? "");
const outDir = resolve(process.argv[3] ?? "");
const m = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
for (const [dir, prefix] of [
  [m.cases_dir, ""],
  [m.visible_dir, "v__"],
]) {
  if (!dir) continue;
  for (const f of readdirSync(join(here, dir)).sort()) {
    if (!f.endsWith(m.input_ext) || f.endsWith(m.expected_ext)) continue;
    const r = spawnSync(process.execPath, [join(delivery, m.entry), join(here, dir, f)], {
      cwd: outDir,
      timeout: m.case_timeout_seconds * 1000,
      maxBuffer: m.max_output_bytes,
      env: { PATH: process.env.PATH ?? "", LANG: "C" },
    });
    if (r.error || r.status !== 0) continue;
    writeFileSync(
      join(outDir, `${prefix}${f.slice(0, -m.input_ext.length)}${m.output_ext}`),
      r.stdout,
    );
  }
}
