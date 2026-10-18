import { ApiError } from "./api.js";

/** The error as one plain sentence; a refused origin (403, or a browser network failure that may be CORS) names the fix. */
export function explainError(
  err: unknown,
  fallback: string,
  origin = window.location.origin,
): string {
  if (!(err instanceof ApiError)) return fallback;
  if (err.code === "CATALOGUE_UNAVAILABLE")
    return `The buyer agent cannot read the engine's task-type list (${err.message})`;
  const fix = `This page's origin is not allowed by the service; set VERDICT_UI_ORIGIN=${origin} on the engine, signer and buyer`;
  if (err.detail.status === 403) return `${err.message} ${fix}`;
  if (err.code === "UNREACHABLE") return `${err.message} If it is running: ${fix}`;
  return err.message;
}
