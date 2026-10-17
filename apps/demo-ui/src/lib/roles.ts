import type { UiEvent } from "@verdict/protocol";
import { Cog, Hammer, ShieldCheck, ShoppingCart, User } from "lucide-react";

export type Role = "principal" | "engine" | "buyer" | "worker" | "verifier";

/** One look per role everywhere it appears (Proof signers, Events filter): icon + word + tint, never colour alone. */
export const ROLES: Record<Role, { label: string; Icon: typeof User; tint: string }> = {
  principal: {
    label: "Principal",
    Icon: User,
    tint: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  },
  engine: {
    label: "Engine",
    Icon: Cog,
    tint: "bg-slate-200 text-slate-900 dark:bg-slate-800 dark:text-slate-100",
  },
  buyer: {
    label: "Buyer",
    Icon: ShoppingCart,
    tint: "bg-cyan-100 text-cyan-900 dark:bg-cyan-950 dark:text-cyan-200",
  },
  worker: {
    label: "Worker",
    Icon: Hammer,
    tint: "bg-fuchsia-100 text-fuchsia-900 dark:bg-fuchsia-950 dark:text-fuchsia-200",
  },
  verifier: {
    label: "Verifier",
    Icon: ShieldCheck,
    tint: "bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200",
  },
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
