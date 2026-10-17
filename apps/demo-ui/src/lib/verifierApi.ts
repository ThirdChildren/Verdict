import { z } from "zod";

const verifierBase = () => {
  const q = new URLSearchParams(location.search).get("verifier");
  const env = import.meta.env;
  return `${location.protocol}//${q ?? `${env.VITE_VERIFIER_HOST ?? location.hostname}:${env.VITE_VERIFIER_PORT ?? "7404"}`}`;
};

const reportSchema = z.object({
  record: z
    .object({
      task_id: z.string(),
      attempt: z.number(),
      verdict: z.enum(["RELEASE", "WITHHOLD"]),
      exit_code: z.number(),
      verifier_package_sha256: z.string(),
      delivery_sha256: z.string(),
      verifier_sig: z.string(),
      checks: z.array(z.object({ id: z.string(), status: z.enum(["PASS", "FAIL"]) })),
    })
    .passthrough(),
  outcome: z.enum(["PASS", "FAIL"]),
  code: z.string().nullable(),
  message: z.string(),
  sandbox: z.string(),
  log_tail: z.array(z.string()),
  verify_sh_sha256: z.string(),
  seconds: z.number(),
});

const taskSchema = z.object({
  task_id: z.string(),
  payment_hash: z.string(),
  released: z.boolean(),
  reports: z.array(reportSchema),
});
export type VerifierTaskView = z.infer<typeof taskSchema>;

export async function fetchVerifierTasks(): Promise<VerifierTaskView[]> {
  const r = await fetch(`${verifierBase()}/v0/verdicts`);
  if (!r.ok) throw new Error("verifier not reachable");
  return z.object({ tasks: z.array(taskSchema) }).parse(await r.json()).tasks;
}
