import { useEffect, useState } from "react";
import { WordButton } from "@/components/ui/word-button";
import { setStatsOpen } from "../lib/statsPanel.js";
import { fetchVerifierTasks, type VerifierTaskView } from "../lib/verifierApi.js";
import { useStore } from "../store.js";
import { Hash } from "./Hash.js";
import { Mark } from "./Mark.js";

const REASON: Record<string, string> = {
  VERIFY_TIMEOUT: "The check ran out of time, so the delivery counts as failed.",
  DELIVERY_HASH_MISMATCH: "The files received are not the files the worker announced.",
  PACKAGE_HASH_MISMATCH: "The test package on this machine is not the one the contract names.",
  DELIVERY_REJECTED:
    "The delivery contained something that is not allowed (links, odd paths, too large).",
  SANDBOX_UNAVAILABLE: "No network sandbox is available here, so the delivery was not run.",
};

/** Verifier lane: what the independent verifier ran, in which sandbox, and what it signed. No model decides this. */
export function VerifierLane() {
  const [task, setTask] = useState<VerifierTaskView | null>(null);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const tasks = await fetchVerifierTasks();
        if (stop) return;
        setTask(
          [...tasks].reverse().find((t) => t.reports.length > 0) ?? tasks[tasks.length - 1] ?? null,
        );
        useStore.getState().setConnection("verifier", "connected");
      } catch {
        if (!stop) useStore.getState().setConnection("verifier", "disconnected");
      }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  const report = task?.reports[task.reports.length - 1];
  const pass = report?.outcome === "PASS";
  return (
    <section aria-label="Verifier" className="border-y-2 border-ink py-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-xl font-semibold">Verifier</h2>
        <WordButton onClick={() => setStatsOpen(true)} aria-label="Open verifier stats (key s)">
          Stats
        </WordButton>
      </div>
      <p aria-live="polite" className="mt-2">
        {!task && "Waiting for a task."}
        {task && !report && "Holding the release secret. Waiting for the worker's delivery."}
        {report && (
          <span className="block text-2xl font-semibold">
            <Mark kind="done" className="mr-1" />
            {pass
              ? "PASS: the delivery passed every check. The secret was released to the worker."
              : "FAIL: the delivery was rejected. The secret stays locked."}
          </span>
        )}
      </p>
      {report && (
        <>
          {!pass && (
            <p className="mt-2 font-semibold">
              {report.code ? (REASON[report.code] ?? report.message) : "At least one check failed."}
            </p>
          )}
          {report.v2?.score != null && report.v2.min_score != null && (
            <p className="mt-3 border-t border-rule py-1.5 font-mono tabular-nums">
              <span className="text-sm font-semibold uppercase tracking-wide">Score </span>
              {report.v2.score} / {report.v2.min_score}
              {report.v2.profile ? (
                <>
                  {" · "}
                  <span className="text-sm font-semibold uppercase tracking-wide">Profile </span>
                  <span className="uppercase">{report.v2.profile}</span>
                </>
              ) : null}
            </p>
          )}
          <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 border-t border-rule pt-2 text-base">
            <dt className="font-semibold">Checks</dt>
            <dd>
              {report.record.checks.length === 0 ? (
                "none ran"
              ) : (
                <ul className="font-mono text-sm">
                  {report.record.checks.map((c) => (
                    <li key={c.id}>
                      <Mark kind={c.status === "PASS" ? "done" : "fail"} className="mr-1" />
                      {c.id}: {c.status === "PASS" ? "passed" : "failed"}
                      {c.status === "FAIL" && report.record.verdict === "RELEASE" && (
                        <span className="text-subtle"> advisory</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
            <dt className="font-semibold">Sandbox</dt>
            <dd>
              {report.sandbox} (no network, fresh folder, {report.seconds} s)
            </dd>
            <dt className="font-semibold">verify.sh</dt>
            <dd>
              <Hash value={report.verify_sh_sha256} label="verify.sh hash" />
            </dd>
            <dt className="font-semibold">Test package</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <Hash value={report.record.verifier_package_sha256} label="package hash" />
              (the contract names this hash)
            </dd>
            <dt className="font-semibold">Exit code</dt>
            <dd>{report.record.exit_code}</dd>
            <dt className="font-semibold">Signed verdict</dt>
            <dd className="flex flex-wrap items-center gap-2">
              {report.record.verdict} · attempt {report.record.attempt} · signature
              <Hash value={report.record.verifier_sig} label="verdict signature" />
            </dd>
          </dl>
          <pre className="mt-3 max-h-40 overflow-auto  border border-rule-soft bg-card p-3 font-mono text-sm">
            {report.log_tail.join("\n")}
          </pre>
        </>
      )}
    </section>
  );
}
