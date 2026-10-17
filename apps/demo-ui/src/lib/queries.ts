import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useStore } from "../store.js";
import {
  type Chain,
  type Evidence,
  fetchChain,
  fetchDemoToggles,
  fetchEvidence,
  fetchTasks,
  newTask,
  proposeMandate,
  signAndInstall,
  simulateCompromisedAgent,
  submitTaskGoal,
} from "./api.js";

export const keys = {
  tasks: ["tasks"] as const,
  chain: ["chain"] as const,
  evidence: (id: string) => ["evidence", id] as const,
};

/** Task descriptions by task id, from the engine's signed contracts. Refetched whenever a task event arrives. */
export function useDescriptions(): Record<string, string> {
  const known = useStore((s) => Object.keys(s.tasks).length);
  const q = useQuery({ queryKey: keys.tasks, queryFn: fetchTasks, staleTime: 5_000 });
  const { refetch } = q;
  // A new task id appearing in the event stream is the refetch trigger.
  useEffect(() => {
    if (known > 0) void refetch();
  }, [known, refetch]);
  const out: Record<string, string> = {};
  for (const t of q.data?.tasks ?? []) out[t.task_id] = t.description;
  return out;
}

export interface ChainInfo {
  height: number;
  lockedAt: number;
  expiresAt: number;
}

/** Chain height of this task's escrow, polled every 2 s while the funds are locked. */
export function useChain(taskId: string | null, locked: boolean): ChainInfo | null {
  const q = useQuery<Chain>({
    queryKey: keys.chain,
    queryFn: fetchChain,
    enabled: locked && taskId !== null,
    refetchInterval: 2000,
    retry: false,
  });
  const p = q.data?.payments.find((x) => x.task_id === taskId);
  if (!locked || !q.data || !p || p.expires_at_height == null) return null;
  return {
    height: q.data.height,
    lockedAt: p.locked_at_height ?? q.data.height,
    expiresAt: p.expires_at_height,
  };
}

export function useEvidence(taskId: string | null, stamp: string | null, verdicts: number) {
  return useQuery<Evidence>({
    queryKey: [...keys.evidence(taskId ?? ""), stamp, verdicts],
    queryFn: () => fetchEvidence(taskId as string),
    enabled: taskId !== null,
    retry: false,
  });
}

export const useProposeMandate = () => useMutation({ mutationFn: proposeMandate });

export const useSignMandate = () =>
  useMutation({
    mutationFn: (v: { goal: string; proposal: unknown; second: boolean; token?: string }) =>
      signAndInstall(v.goal, v.proposal, v.second, v.token),
  });

export function useStartTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { amount: string; goal: string }) => {
      await newTask(v.amount);
      await submitTaskGoal(v.goal);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.tasks });
    },
  });
}

export const useAttack = () => useMutation({ mutationFn: simulateCompromisedAgent });

/** True when the engine runs with the demo switches (the demo console may exist). Re-checked once a minute. */
export function useDemoToggles(): boolean {
  const q = useQuery({
    queryKey: ["demo-toggles"],
    queryFn: fetchDemoToggles,
    refetchInterval: 60_000,
    retry: false,
  });
  return q.data === true;
}
