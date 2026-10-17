// pnpm verifier:rerun -- --task <task id> [package dir]   (delivery fetched from the worker)
// pnpm verifier:rerun -- <delivery.tar.gz> [package dir]
// Runs the same verifier package locally, in the same sandbox, and prints the exit code. Used live in the demo to show
// that the verdict is reproducible on any machine.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPeers } from "@verdict/identity";
import { dirHashFromDisk } from "@verdict/protocol/node";
import { RerunError, rerunTask } from "./rerun-task.js";
import { extractTarball, runVerification } from "./runner.js";

const args = process.argv.slice(2).filter((a) => a !== "--");
const taskIdx = args.indexOf("--task");
const taskId = taskIdx >= 0 ? args[taskIdx + 1] : undefined;
const rest = taskIdx >= 0 ? args.filter((_, i) => i !== taskIdx && i !== taskIdx + 1) : args;
const defaultPkg = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../verifier-packages/csv2json-v1",
);
if (taskIdx >= 0) {
  const packageDir = resolve(rest[0] ?? defaultPkg);
  try {
    if (!taskId) throw new RerunError("Missing task id. Copy it from the Proof tab.");
    const rep = await rerunTask({ taskId, workerUrl: loadPeers().worker, packageDir });
    for (const l of rep.lines) console.log(l);
    process.exitCode = rep.outcome === "PASS" ? 0 : 1;
  } catch (e) {
    console.error(`Cannot re-run: ${e instanceof Error ? e.message : "unknown error"}`);
    process.exitCode = 2;
  }
  process.exit();
}
const [tarball, pkgArg] = rest;
if (!tarball) {
  console.error(
    "usage: pnpm verifier:rerun -- --task <task id>   (or <delivery.tar.gz> [package-dir])",
  );
  process.exit(2);
}
const packageDir = resolve(pkgArg ?? defaultPkg);
const tmp = mkdtempSync(join(tmpdir(), "verifier-rerun-"));
try {
  const dest = join(tmp, "delivery");
  mkdirSync(dest);
  extractTarball(resolve(tarball), dest);
  const r = await runVerification({
    packageDir,
    deliveryDir: dest,
    maxVerifySeconds: 60,
  });
  console.log(`package   ${await dirHashFromDisk(packageDir)}`);
  console.log(`delivery  ${await dirHashFromDisk(dest)}`);
  console.log(`sandbox   ${r.sandbox}`);
  for (const c of r.checks) console.log(`check     ${c.id}: ${c.status}`);
  console.log(`exit code ${r.exitCode ?? "none"} -> ${r.outcome} ${r.code ?? ""} ${r.message}`);
  process.exitCode = r.outcome === "PASS" ? 0 : 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
