// pnpm verifier:rerun -- --task <task id> [package dir]   (delivery fetched from the worker)
// pnpm verifier:rerun -- <delivery.tar.gz> [package dir]
// Runs the same verifier package locally, in the same sandbox, and prints the exit code. Used live in the demo to show
// that the verdict is reproducible on any machine.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir, loadPeers } from "@verdict/identity";
import { dirHashFromDisk } from "@verdict/protocol/node";
import { Catalogue } from "./catalogue.js";
import { Registry } from "./registry.js";
import { RerunError, rerunTask } from "./rerun-task.js";
import { extractTarball, runVerification } from "./runner.js";

const args = process.argv.slice(2).filter((a) => a !== "--");
const taskIdx = args.indexOf("--task");
const taskId = taskIdx >= 0 ? args[taskIdx + 1] : undefined;
const hashIdx = args.indexOf("--hash");
const hashArg = hashIdx >= 0 ? args[hashIdx + 1] : undefined;
const skip = new Set<number>([taskIdx, hashIdx].flatMap((i) => (i >= 0 ? [i, i + 1] : [])));
const rest = args.filter((_, i) => !skip.has(i));
const defaultPkg = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../verifier-packages/csv2json-v1",
);
const packagesRoot = process.env.VERIFIER_PACKAGES_ROOT ?? resolve(dirname(defaultPkg));
async function byHash(hash: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(hash))
    throw new RerunError("--hash must be 64 lowercase hex characters.");
  const e = (await Catalogue.fromRoot(packagesRoot)).byHash(hash);
  if (!e?.usable) throw new RerunError("No package on this machine matches the recorded hash.");
  return e.dir;
}
/** The package hash the verifier recorded for a task (its local registry). */
function recordedHash(id: string): string | null {
  const file = process.env.VERIFIER_REGISTRY ?? resolve(dataDir(), "verifier", "registry.json");
  return new Registry(file).get(id)?.package_sha256 ?? null;
}
if (taskIdx >= 0) {
  try {
    if (!taskId) throw new RerunError("Missing task id. Copy it from the Proof tab.");
    const pkgForTask = async (id: string): Promise<string> => {
      const h = recordedHash(id);
      return h ? byHash(h) : defaultPkg;
    };
    const rep = await rerunTask({
      taskId,
      workerUrl: loadPeers().worker,
      packageDir: rest[0] ? resolve(rest[0]) : await pkgForTask(taskId),
    });
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
    "usage: pnpm verifier:rerun -- --task <task id>   (or <delivery.tar.gz> [package-dir | --hash <package sha256>])",
  );
  process.exit(2);
}
const packageDir = pkgArg ? resolve(pkgArg) : hashArg ? await byHash(hashArg) : defaultPkg;
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
