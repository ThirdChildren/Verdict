import type { UiEvent } from "@verdict/protocol";

export type Role = "principal" | "engine" | "buyer" | "worker" | "verifier";

/** One look per role everywhere it appears (Proof signers, Events filter): an uppercase word, no colour. */
export const ROLES: Record<Role, { label: string }> = {
  principal: { label: "Principal" },
  engine: { label: "Engine" },
  buyer: { label: "Buyer" },
  worker: { label: "Worker" },
  verifier: { label: "Verifier" },
};

/** Which machine or key produced a protocol message. */
export function roleOfEvent(e: UiEvent): Role {
  switch (e.type) {
    case "CAP_ROOT":
      return "principal";
    case "VERDICT":
      return "verifier";
    case "CLAIMED":
    case "WORKER_STREAM":
      return "worker";
    default:
      return "engine";
  }
}
