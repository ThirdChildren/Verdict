import { useMemo, useState } from "react";
import { eventsFor } from "../lib/events.js";
import { ROLES, type Role, roleOfEvent } from "../lib/roles.js";
import { useStore } from "../store.js";
import { RoleBadge } from "./RoleBadge.js";

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

/** Raw protocol messages for the selected task, newest first, JSON on demand, filtered by who sent them. */
export function EventsTab() {
  const all = useStore((s) => s.events);
  const tasks = useStore((s) => s.tasks);
  const selected = useStore((s) => s.selected);
  const currentTask = useStore((s) => s.currentTask);
  const events = useMemo(
    () => eventsFor({ events: all, tasks, selected, currentTask }),
    [all, tasks, selected, currentTask],
  );
  const [role, setRole] = useState<Role | "all">("all");
  const counts = new Map<Role, number>();
  for (const e of events) counts.set(roleOfEvent(e), (counts.get(roleOfEvent(e)) ?? 0) + 1);
  const shown = role === "all" ? events : events.filter((e) => roleOfEvent(e) === role);
  return (
    <section aria-label="Protocol messages" className="grid gap-3">
      {events.length === 0 ? (
        <p className="text-muted-foreground">No messages yet. They appear as the task moves.</p>
      ) : (
        <>
          <nav aria-label="Filter by sender" className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={role === "all"}
              onClick={() => setRole("all")}
              className={`rounded-full border px-3 py-1 text-sm ${role === "all" ? "border-primary bg-accent font-semibold" : ""}`}
            >
              All {events.length}
            </button>
            {[...counts.entries()].map(([r, n]) => (
              <button
                key={r}
                type="button"
                aria-pressed={role === r}
                onClick={() => setRole(r)}
                className={`rounded-full border px-3 py-1 text-sm ${role === r ? "border-primary bg-accent font-semibold" : ""}`}
              >
                {ROLES[r].label} {n}
              </button>
            ))}
          </nav>
          <ol className="grid gap-2" aria-live="polite">
            {shown.map((e) => (
              <li key={e.seq} className="rounded-lg border p-2">
                <details>
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                    <span className="tabular-nums text-muted-foreground">#{e.seq}</span>
                    <code className="font-mono">{e.type}</code>
                    <RoleBadge role={roleOfEvent(e)} />
                    <span className="ml-auto tabular-nums text-muted-foreground">
                      {clock(e.at)}
                    </span>
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap break-all">
                    {JSON.stringify(e, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
