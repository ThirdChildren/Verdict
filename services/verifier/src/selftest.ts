// pnpm verifier:selftest - runs hostile and honest deliveries through THIS machine's sandbox and prints PASS or FAIL per fixture.
// PASS means the sandbox did its job (the attack was contained, or the honest delivery was accepted). Exit 1 on any FAIL.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { dirHashFromDisk } from "@verdict/protocol/node";
import { gunzipBounded } from "./extract.js";
import { detectSandbox, runVerification, sandboxArgv } from "./runner.js";

const PKG =
  process.env.VERIFIER_PACKAGE_DIR ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../verifier-packages/csv2json-v1");
const GOOD = join(PKG, "fixtures/good-delivery");
const BAD = join(PKG, "fixtures/bad-delivery");

const kind = detectSandbox();
if (kind === null) {
  console.error(
    "FAIL  no usable sandbox on this machine (needs bubblewrap and prlimit on Linux, or sandbox-exec on macOS). The verifier would refuse to start.",
  );
  process.exit(1);
}
const sandbox = kind;
const scratch = mkdtempSync(join(tmpdir(), "verifier-selftest-"));

type Result = { ok: boolean; detail: string } | "skip";
const results: { name: string; res: Result }[] = [];

function delivery(name: string, source: string): string {
  const d = join(scratch, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "csv2json.mjs"), source);
  return d;
}

function shortTimeoutPackage(name: string, seconds: number): string {
  const d = join(scratch, name);
  cpSync(PKG, d, { recursive: true });
  const m = JSON.parse(readFileSync(join(d, "manifest.json"), "utf8"));
  m.case_timeout_seconds = seconds;
  writeFileSync(join(d, "manifest.json"), JSON.stringify(m));
  return d;
}

const run = (deliveryDir: string, packageDir = PKG, maxVerifySeconds = 30) =>
  runVerification({ packageDir, deliveryDir, maxVerifySeconds });

/** Runs a script as the delivery inside this machine's real sandbox and returns what it printed. */
function inSandbox(source: string): string {
  const d = delivery(`probe-${Math.random().toString(36).slice(2)}`, source);
  const inputs = join(scratch, "probe-inputs");
  mkdirSync(inputs, { recursive: true });
  writeFileSync(join(inputs, "x.csv"), "a\n");
  const [cmd, args] = sandboxArgv(
    sandbox,
    { delivery: d, inputs, scratch: join(scratch, "unused") },
    "csv2json.mjs",
    "x.csv",
    { cpuSeconds: 10, fsizeBytes: 1024 * 1024 },
  );
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 20_000,
    env: { PATH: "/usr/bin:/bin" },
  });
  return (r.stdout ?? "").trim();
}

async function fixture(name: string, fn: () => Promise<Result> | Result): Promise<void> {
  let res: Result;
  try {
    res = await fn();
  } catch (e) {
    res = { ok: false, detail: `selftest crashed: ${(e as Error).message}` };
  }
  results.push({ name, res });
  const tag = res === "skip" ? "SKIP" : res.ok ? "PASS" : "FAIL";
  console.log(`${tag}  ${name}${res === "skip" || !res.detail ? "" : ` - ${res.detail}`}`);
}

console.log(`verifier selftest: sandbox ${sandbox}, package ${PKG}`);
console.log(`package hash ${await dirHashFromDisk(PKG)}\n`);

await fixture("honest delivery is accepted (PASS)", async () => {
  const r = await run(GOOD);
  return { ok: r.outcome === "PASS", detail: `outcome ${r.outcome}` };
});

await fixture("broken delivery is rejected (FAIL)", async () => {
  const r = await run(BAD);
  return { ok: r.outcome === "FAIL", detail: `outcome ${r.outcome}` };
});

await fixture("malicious delivery cannot overwrite expected files or the judge", async () => {
  const before = await dirHashFromDisk(PKG);
  const d = delivery(
    "overwrite",
    `import fs from "node:fs";
import path from "node:path";
const targets = [${JSON.stringify(join(PKG, "cases"))}, ${JSON.stringify(PKG)}, "../package", "../../package", "/package"];
for (const t of targets) for (const f of ["verify.mjs", "simple.expected.json", "cases/simple.expected.json"]) {
  try { fs.chmodSync(path.join(t, f), 0o644); } catch {}
  try { fs.writeFileSync(path.join(t, f), "[]"); } catch {}
}
console.log("[]");`,
  );
  const r = await run(d);
  const same = (await dirHashFromDisk(PKG)) === before;
  return {
    ok: r.outcome === "FAIL" && same,
    detail: `outcome ${r.outcome}, package ${same ? "unchanged" : "CHANGED"}`,
  };
});

await fixture("malicious delivery cannot read the expected answers", () => {
  const out = inSandbox(`import fs from "node:fs";
let read = 0;
for (const dir of [${JSON.stringify(join(PKG, "cases"))}, ${JSON.stringify(PKG)}, "../package/cases", "/package/cases"]) {
  try { for (const f of fs.readdirSync(dir)) if (f.endsWith(".expected.json")) { fs.readFileSync(dir + "/" + f); read++; } } catch {}
}
console.log(read === 0 ? "NONE" : "READ " + read);`);
  return { ok: out === "NONE", detail: out || "no output" };
});

await fixture("write outside the delivery dir is blocked", () => {
  const victim = join(scratch, "victim.txt");
  writeFileSync(victim, "untouched");
  inSandbox(`import fs from "node:fs";
for (const p of [${JSON.stringify(victim)}, "/etc/verdict-selftest", "/tmp/verdict-selftest"]) { try { fs.writeFileSync(p, "pwned"); } catch {} }`);
  const intact = readFileSync(victim, "utf8") === "untouched";
  const planted = existsSync("/etc/verdict-selftest") || existsSync("/tmp/verdict-selftest");
  rmSync("/tmp/verdict-selftest", { force: true });
  return {
    ok: intact && !planted,
    detail: intact && !planted ? "nothing written" : "a file was written outside",
  };
});

await fixture("network attempt is blocked", async () => {
  const server = createServer((s) => s.end());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const out = inSandbox(`import net from "node:net";
net.connect(${port}, "127.0.0.1").on("connect", () => console.log("CONNECTED")).on("error", () => console.log("BLOCKED"));`);
    return { ok: out === "BLOCKED", detail: out || "no output" };
  } finally {
    server.close();
  }
});

await fixture("fork bomb fails the delivery and the verifier keeps working", async () => {
  const d = delivery(
    "forkbomb",
    `import { spawn } from "node:child_process";
for (;;) { try { spawn(process.execPath, [process.argv[1], process.argv[2]], { stdio: "ignore" }); } catch {} }`,
  );
  const r = await run(d, shortTimeoutPackage("bomb-pkg", 2), 60);
  const after = await run(GOOD);
  return {
    ok: r.outcome === "FAIL" && after.outcome === "PASS",
    detail: `bomb ${r.outcome}, honest delivery afterwards ${after.outcome}`,
  };
});

await fixture(
  "unbounded allocation fails the delivery and the verifier keeps working",
  async () => {
    if (process.platform === "darwin") return "skip"; // macOS has no memory cap in this sandbox; not run so it cannot exhaust your Mac
    const d = delivery(
      "memhog",
      `const keep = [];\nfor (;;) keep.push(Buffer.alloc(64 * 1024 * 1024, 1));`,
    );
    const r = await run(d, shortTimeoutPackage("mem-pkg", 5), 60);
    const after = await run(GOOD);
    return {
      ok: r.outcome === "FAIL" && after.outcome === "PASS",
      detail: `hog ${r.outcome}, honest delivery afterwards ${after.outcome}`,
    };
  },
);

await fixture("hanging delivery is stopped at the time budget", async () => {
  const d = delivery("hang", `setInterval(() => {}, 1000);`);
  const t0 = Date.now();
  const r = await run(d, shortTimeoutPackage("hang-pkg", 1), 30);
  const s = (Date.now() - t0) / 1000;
  return {
    ok: r.outcome === "FAIL" && s < 20,
    detail: `outcome ${r.outcome} after ${s.toFixed(1)} s`,
  };
});

await fixture("gzip bomb is rejected before anything is written", () => {
  const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));
  try {
    gunzipBounded(bomb);
    return { ok: false, detail: "the bomb was expanded" };
  } catch (e) {
    return { ok: true, detail: (e as Error).message };
  }
});

rmSync(scratch, { recursive: true, force: true });
const failed = results.filter((r) => r.res !== "skip" && !r.res.ok).length;
const skipped = results.filter((r) => r.res === "skip").length;
console.log(
  `\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped. ${failed === 0 ? "This machine is safe to run as the verifier." : "Do NOT run the verifier on this machine until every fixture passes."}`,
);
process.exit(failed === 0 ? 0 : 1);
