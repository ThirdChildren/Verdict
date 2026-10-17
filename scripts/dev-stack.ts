// pnpm dev:stack [--wallet] - dev:stop, then engine + principal-signer + buyer-agent + demo-ui (+ wallet daemons).
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir, loadIdentities, loadNetwork } from "../packages/wallet/src/index.js";
import { workerDirectory } from "../services/buyer-agent/src/identities.js";
import { stopDev } from "./dev-stop.js";

// Demo-only switches (sabotaged worker, disappearing worker, compromised-agent attack) exist only under dev:stack (L1).
process.env.VERDICT_DEMO_TOGGLES = "1";
const wallet = process.argv.includes("--wallet");
if (wallet) process.env.VERDICT_WALLET = "1";
const missing = [
  [join(dataDir(), "identities.json"), "pnpm keys:init"],
  [join(dataDir(), "network.json"), "pnpm regtest:setup"],
].filter(([f]) => !existsSync(f as string));
if (missing.length > 0) {
  for (const [f, cmd] of missing) console.error(`[dev:stack] missing ${f}: run ${cmd}`);
  process.exit(1);
}
// Wallet daemons are never restarted here: after a restart the RGB channel stays open on paper but its HTLCs never
// become Claimable, so every task stalls at "invoice sent" (verified 12 Oct). Only demo:reset starts them, with the channel.
await stopDev();
if (wallet) {
  const healthy = async (url: string) => {
    try {
      return (await fetch(`${url}/v0/health`, { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      return false;
    }
  };
  if (!(await healthy("http://127.0.0.1:7411")) || !(await healthy("http://127.0.0.1:7412"))) {
    console.error(
      "[dev:stack] the wallet daemons are not running. Run: pnpm demo:reset (it starts them and opens the channel). Restarting them alone leaves a channel that never locks escrow.",
    );
    process.exit(1);
  }
  console.log("[dev:stack] wallet daemons already running (kept as they are)");
}

const procs: (readonly [string, string, string])[] = [
  ["engine", "blue", "pnpm --filter @verdict/capability-engine start"],
  ["signer", "cyan", "pnpm --filter @verdict/principal-signer start"],
  ["buyer", "magenta", "pnpm --filter @verdict/buyer-agent start"],
  ["ui", "yellow", "pnpm --filter @verdict/demo-ui dev"],
];
// The worker needs its wallet daemon and loads the 9B model (about 12 s plus warm-up).
if (wallet) procs.push(["worker", "green", "pnpm --filter @verdict/worker start"]);
// On the demo day the verifier runs on the Mac (pnpm dev:verifier); here it runs next to the rest for rehearsal.
if (wallet) procs.push(["verifier", "white", "pnpm --filter @verdict/verifier start"]);
const cc = spawn(
  "pnpm",
  [
    "exec",
    "concurrently",
    "-k",
    "-n",
    procs.map((p) => p[0]).join(","),
    "-c",
    procs.map((p) => p[1]).join(","),
    ...procs.map((p) => p[2]),
  ],
  { stdio: ["inherit", "pipe", "pipe"] },
);
// All service output also goes to ./.logs/dev-stack.log (repo-local, gitignored, ANSI stripped). Services already redact secrets.
mkdirSync(".logs", { recursive: true });
const logFile = createWriteStream(join(".logs", "dev-stack.log"), { flags: "w" });
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes
const ansi = /\u001b\[[0-9;]*m/g;
for (const [src, dst] of [
  [cc.stdout, process.stdout],
  [cc.stderr, process.stderr],
] as const) {
  src.on("data", (d: Buffer) => {
    dst.write(d);
    logFile.write(d.toString().replace(ansi, ""));
  });
}
cc.on("exit", (c) => process.exit(c ?? 0));
for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => cc.kill(s));

const up = async (url: string, ok: (j: Record<string, unknown>) => boolean): Promise<boolean> => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return r.ok && ok((await r.json().catch(() => ({}))) as Record<string, unknown>);
  } catch {
    return false;
  }
};
const checks: [string, () => Promise<boolean>][] = [
  ["engine", () => up("http://127.0.0.1:7401/health", () => true)],
  ["signer", () => up("http://127.0.0.1:7403/health", () => true)],
  ["buyer model", () => up("http://127.0.0.1:7402/health", (j) => j.model_ready === true)],
  ...(wallet
    ? ([
        ["worker", () => up("http://127.0.0.1:7405/health", () => true)],
        ["verifier", () => up("http://127.0.0.1:7404/health", () => true)],
      ] as typeof checks)
    : []),
  [
    "ui",
    () =>
      fetch("http://127.0.0.1:5173/").then(
        (r) => r.ok,
        () => false,
      ),
  ],
];
const deadline = Date.now() + 10 * 60_000;
let pending = checks;
while (pending.length > 0 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  const left: typeof checks = [];
  for (const c of pending) if (!(await c[1]())) left.push(c);
  pending = left;
}
if (pending.length > 0) {
  console.error(`[dev:stack] not ready after 10 min: ${pending.map((p) => p[0]).join(", ")}`);
} else {
  const dir = dataDir();
  const names = Object.keys(
    workerDirectory(loadIdentities(dir) as unknown as Record<string, unknown>),
  );
  const asset = loadNetwork(dir).tusd_asset_id;
  const short = asset.length > 20 ? `${asset.slice(0, 12)}…${asset.slice(-6)}` : asset;
  console.log(
    [
      "",
      "================ VERDICT dev stack ready ================",
      "  UI:      http://localhost:5173",
      `  Worker:  ${names.map((n) => `"${n}"`).join(", ")}  <- use this name in the mandate text`,
      `  tUSD:    ${short}`,
      `  Wallets: ${wallet ? "daemons started (buyer :7411, worker :7412)" : "not started (use --wallet)"}`,
      "  Services:",
      "    engine :7401  buyer-agent :7402  signer :7403",
      `    verifier :7404  worker :7405${wallet ? "" : "  (the last two need --wallet)"}`,
      "    demo toggles: ON (VERDICT_DEMO_TOGGLES=1)",
      "=========================================================",
      "",
    ].join("\n"),
  );
}
