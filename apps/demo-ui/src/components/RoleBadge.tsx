import { ROLES, type Role } from "../lib/roles.js";

/** Role as an uppercase mono word: the same everywhere, no colour, no icon. */
export function RoleBadge({ role }: { role: Role }) {
  return <span className="font-mono text-sm font-semibold uppercase">{ROLES[role].label}</span>;
}
