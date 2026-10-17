import { useMemo, useState } from "react";
import { eventsFor } from "../lib/events.js";
import { ROLES, type Role, roleOfEvent } from "../lib/roles.js";
import { useStore } from "../store.js";
import { RoleBadge } from "./RoleBadge.js";

const FILTER =
  "cursor-pointer text-sm uppercase underline decoration-rule underline-offset-4 outline-none hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink aria-pressed:font-semibold aria-pressed:decoration-2 aria-pressed:decoration-ink";

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
        <p className="text-subtle">No messages yet. They appear as the task moves.</p>
      ) : (
        <>
          <nav aria-label="Filter by sender" className="flex flex-wrap gap-x-4 gap-y-1">
            <button
              type="button"
              aria-pressed={role === "all"}
              onClick={() => setRole("all")}
              className={FILTER}
            >
              All {events.length}
            </button>
            {[...counts.entries()].map(([r, n]) => (
              <button
                key={r}
                type="button"
                aria-pressed={role === r}
                onClick={() => setRole(r)}
                className={FILTER}
              >
                {ROLES[r].label} {n}
              </button>
            ))}
          </nav>
          <ol className="grid divide-y divide-rule-soft border-y border-rule" aria-live="polite">
            {shown.map((e) => (
              <li key={e.seq} className="py-2">
                <details>
                  <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 text-sm">
                    <span className="font-mono text-subtle">#{e.seq}</span>
                    <code className="font-mono">{e.type}</code>
                    <RoleBadge role={roleOfEvent(e)} />
                    <span className="ml-auto font-mono text-subtle">{clock(e.at)}</span>
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto border border-rule p-2 font-mono text-xs whitespace-pre-wrap break-all">
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
