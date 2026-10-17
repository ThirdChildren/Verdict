import type { ChildCapability, RootCapability } from "@verdict/protocol";
import { contractHash, dirHash, hashUnsigned } from "@verdict/protocol";
import type { Evidence } from "../lib/api.js";
import { VERDICT_CAPTIONS } from "../lib/captions.js";
import { useEvidence } from "../lib/queries.js";
import { ROLES, type Role } from "../lib/roles.js";
import { useStore } from "../store.js";
import { Hash } from "./Hash.js";
import { HashCheck } from "./HashCheck.js";
import { RoleBadge } from "./RoleBadge.js";
import { TaskIdCopy } from "./TaskIdCopy.js";

/** Recomputes the three hashes in the browser, with the same functions the services use. */
export function EvidenceChecks({ ev }: { ev: Evidence }) {
  const contractNow = ev.contract ? contractHash(ev.contract) : null;
  const deliveryNow = ev.delivery
    ? dirHash(
        ev.delivery.files.map((f) => ({
          path: f.path,
          bytes: new TextEncoder().encode(f.content),
        })),
      )
    : null;
  const v = ev.verdict;
  const linksOk =
    v && contractNow && deliveryNow
      ? v.contract_sha256 === contractNow && v.delivery_sha256 === deliveryNow
      : false;
  return (
    <div className="mt-3 grid">
      {ev.contract_sha256 ? (
        <HashCheck label="Contract" shown={ev.contract_sha256} recomputed={contractNow} />
      ) : (
        <p className="text-base text-subtle">Contract: not available yet.</p>
      )}
      {ev.delivery ? (
        <HashCheck label="Delivery" shown={ev.delivery.sha256} recomputed={deliveryNow} />
      ) : (
        <p className="text-base text-subtle">Delivery: nothing delivered yet.</p>
      )}
      {v ? (
        <>
          <div className="flex items-baseline gap-2 border-b border-rule-soft py-1.5 text-base">
            <span aria-hidden>■</span>{" "}
            <span className="text-sm font-semibold uppercase">Verifier package</span>{" "}
            <Hash value={v.verifier_package_sha256} label="package hash" />
          </div>
          <HashCheck
            label="Verdict"
            shown={hashUnsigned(v)}
            recomputed={contractNow && deliveryNow ? hashUnsigned(v) : null}
            matches={linksOk}
            note="The record names exactly this contract and this delivery."
          />
          <p className="text-base">{VERDICT_CAPTIONS[v.verdict]}</p>
        </>
      ) : (
        <p className="text-base text-subtle">Verdict: none signed yet.</p>
      )}
      <p className="text-sm text-subtle">
        The verifier's signature itself is checked by the engine and the verifier, not here.
      </p>
    </div>
  );
}

const EARLY_STATES = new Set<string>(["DRAFT", "MANDATE_SIGNED", "CHILD_DERIVED"]);

interface Signer {
  role: Role;
  what: string;
  id: string | null;
  signature: string | null;
}

/** Who signed what, from the signed objects themselves. A missing signature is shown as "not yet". */
export function signersOf(
  root: RootCapability | null,
  child: ChildCapability | null,
  ev: Evidence | undefined,
): Signer[] {
  const c = ev?.contract as
    | {
        buyer?: string;
        worker?: string;
        verifier?: { public_id?: string };
        signatures?: { buyer?: string; worker?: string };
      }
    | null
    | undefined;
  return [
    {
      role: "principal",
      what: "Mandate",
      id: root?.issuer ?? null,
      signature: root?.signature ?? null,
    },
    {
      role: "engine",
      what: "Task permission",
      id: child?.issuer ?? null,
      signature: child?.signature ?? null,
    },
    {
      role: "buyer",
      what: "Contract offer",
      id: c?.buyer ?? null,
      signature: c?.signatures?.buyer ?? null,
    },
    {
      role: "worker",
      what: "Contract accepted",
      id: c?.worker ?? null,
      signature: c?.signatures?.worker ?? null,
    },
    {
      role: "verifier",
      what: "Verdict",
      id: c?.verifier?.public_id ?? null,
      signature: ev?.verdict?.verifier_sig ?? null,
    },
  ];
}

export function SignersList({ signers }: { signers: Signer[] }) {
  return (
    <ul
      className="grid divide-y divide-rule-soft border-y border-rule"
      aria-label="Who signed what"
    >
      {signers.map((x) => (
        <li key={x.role} className="grid gap-1 py-2">
          <div className="flex items-baseline gap-3">
            <RoleBadge role={x.role} />
            <span className="text-base">{x.what}</span>
          </div>
          {x.signature && x.id ? (
            <div className="grid gap-0.5 text-sm text-subtle">
              <span className="flex items-baseline gap-2">
                key <Hash value={x.id} label={`${ROLES[x.role].label} key`} />
              </span>
              <span className="flex items-baseline gap-2">
                signature <Hash value={x.signature} label={`${ROLES[x.role].label} signature`} />
              </span>
            </div>
          ) : (
            <p className="text-sm text-subtle">Not signed yet.</p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Proof tab: three hashes recomputed in the browser, and who signed what. */
export function ProofTab() {
  const taskId = useStore((s) => (s.selected && s.tasks[s.selected] ? s.selected : s.currentTask));
  const stamp = useStore((s) => (taskId ? (s.tasks[taskId]?.state ?? null) : null));
  const verdicts = useStore((s) => s.verdicts.length);
  const root = useStore((s) => s.root);
  const child = useStore((s) => s.child);
  // Nothing to ask before the engine has offered the task.
  const ready = taskId !== null && !(stamp && EARLY_STATES.has(stamp));
  const q = useEvidence(ready ? taskId : null, stamp, verdicts);
  const ev = q.data && q.data.task_id === taskId ? q.data : undefined;
  return (
    <div className="grid gap-6">
      <section aria-label="Evidence">
        <h2 className="text-xl font-semibold">Check it yourself</h2>
        {taskId && (
          <div className="mt-2">
            <TaskIdCopy taskId={taskId} />
          </div>
        )}
        <div aria-live="polite">
          {!taskId && <p className="mt-2 text-subtle">No task yet.</p>}
          {taskId && q.isError && !ev && (
            <p className="mt-2 text-subtle">Evidence is not available from the engine right now.</p>
          )}
          {ev && <EvidenceChecks ev={ev} />}
        </div>
      </section>
      <section aria-label="Signatures">
        <h2 className="mb-2 text-xl font-semibold">Who signed what</h2>
        <SignersList signers={signersOf(root, child, ev)} />
      </section>
    </div>
  );
}
