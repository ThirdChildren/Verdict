import { spawnSync } from "node:child_process";

/** GPU memory in use, MiB, summed over GPUs by nvidia-smi; null when nvidia-smi is not available. */
export function gpuMemoryUsedMiB(): number | null {
  const r = spawnSync("nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (r.status !== 0) return null;
  const v = r.stdout
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0);
}

/** Preflight rule: the RTX 3080 has 16 GB; with both models loaded the demo needs headroom for the verifier sandbox and the desktop. */
export const VRAM_LIMIT_MIB = 15 * 1024;

/** Samples gpuMemoryUsedMiB every `ms` and remembers the peak. */
export function peakSampler(ms = 500): { stop: () => number | null } {
  let peak: number | null = null;
  const sample = () => {
    const v = gpuMemoryUsedMiB();
    if (v !== null) peak = Math.max(peak ?? 0, v);
  };
  sample();
  const t = setInterval(sample, ms);
  return {
    stop: () => {
      clearInterval(t);
      sample();
      return peak;
    },
  };
}
