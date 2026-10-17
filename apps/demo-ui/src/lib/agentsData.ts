import { useQuery } from "@tanstack/react-query";
import { mockVerifierTask, mockWorkerTask } from "../mock/agents.js";
import { type Evidence, fetchEvidence } from "./api.js";
import { type BuyerEvent, fetchBuyerEvents } from "./buyerApi.js";
import { fetchVerifierTasks, type VerifierTaskView } from "./verifierApi.js";
import { fetchWorkerDelivery, fetchWorkerTasks, type WorkerTaskView } from "./workerApi.js";

/** A value that may still load, or whose service may be down. Never a guess. */
export type Remote<T> = { status: "loading" | "unreachable" } | { status: "ready"; data: T };
export const loadingRemote = { status: "loading" } as const;

export interface DeliveryFile {
  path: string;
  content: string;
}
export interface AgentsData {
  worker: Remote<WorkerTaskView | null>;
  verifier: Remote<VerifierTaskView | null>;
  evidence: Remote<Evidence | null>;
  delivery: Remote<DeliveryFile[] | null>;
  buyer: Remote<BuyerEvent[]>;
}

function remote<T>(q: { isError: boolean; isPending: boolean; data: T | undefined }): Remote<T> {
  if (q.isError) return { status: "unreachable" };
  if (q.isPending || q.data === undefined) return { status: "loading" };
  return { status: "ready", data: q.data };
}

const POLL = 2000;

/** Read-only data for the Agents panel of one task, polled every 2 s while open. In mock mode nothing is fetched. */
export function useAgentsData(
  taskId: string | null,
  stamp: string | null,
  mock: boolean,
  open: boolean,
): AgentsData {
  const on = open && taskId !== null;
  const id = taskId ?? "";
  const live = on && !mock;
  const opts = { retry: false, refetchInterval: mock ? (false as const) : POLL };
  const worker = useQuery({
    queryKey: ["agents", "worker", id],
    queryFn: async (): Promise<WorkerTaskView | null> =>
      mock ? mockWorkerTask(id) : ((await fetchWorkerTasks()).find((t) => t.taskId === id) ?? null),
    enabled: on,
    ...opts,
  });
  const verifier = useQuery({
    queryKey: ["agents", "verifier", id],
    queryFn: async (): Promise<VerifierTaskView | null> =>
      mock
        ? mockVerifierTask(id)
        : ((await fetchVerifierTasks()).find((t) => t.task_id === id) ?? null),
    enabled: on,
    ...opts,
  });
  const evidence = useQuery({
    queryKey: ["agents", "evidence", id, stamp],
    queryFn: async (): Promise<Evidence | null> => fetchEvidence(id),
    enabled: on,
    ...opts,
  });
  const delivery = useQuery({
    queryKey: ["agents", "delivery", id, stamp],
    queryFn: async (): Promise<DeliveryFile[] | null> => fetchWorkerDelivery(id),
    enabled: live,
    ...opts,
  });
  const buyer = useQuery({
    queryKey: ["agents", "buyer"],
    queryFn: async (): Promise<BuyerEvent[]> => (mock ? [] : fetchBuyerEvents()),
    enabled: open,
    ...opts,
  });
  return {
    worker: remote(worker),
    verifier: remote(verifier),
    evidence: remote(evidence),
    // Mock mode has no worker fetch: the canned evidence already carries the file.
    delivery: mock ? { status: "ready", data: null } : remote(delivery),
    buyer: remote(buyer),
  };
}
