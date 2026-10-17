import { ROLES, type Role } from "../lib/roles.js";

/** Role label with its icon and tint: the same everywhere. */
export function RoleBadge({ role }: { role: Role }) {
  const { label, Icon, tint } = ROLES[role];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-sm ${tint}`}>
      <Icon aria-hidden className="size-4" />
      {label}
    </span>
  );
}
