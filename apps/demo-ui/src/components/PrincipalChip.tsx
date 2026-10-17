import { KeyRound, ShieldAlert } from "lucide-react";
import { connectPrincipal, principalChip, shortPrincipal } from "../lib/principal.js";
import { useStore } from "../store.js";

const PILL =
  "inline-flex shrink-0 items-center gap-2 rounded-full border border-rule-soft bg-card px-3 py-1.5 text-sm whitespace-nowrap shadow-soft transition";

/** Header control: "Connect principal" until connected, then a chip with the principal's public id. */
export function PrincipalChip() {
  const p = useStore((s) => s.principal);
  if (p.status === "connected")
    return (
      <span
        className={`${PILL} font-mono`}
        title={`${p.id}\nThe key is held by the principal-signer process, not by this screen.`}
      >
        <KeyRound aria-hidden className="size-4 text-ok" />
        <span className="hidden min-[1440px]:inline">{principalChip(p.id)}</span>
        <span className="min-[1440px]:hidden">{shortPrincipal(p.id)}</span>
      </span>
    );
  if (p.status === "error")
    return (
      <button
        type="button"
        className={`${PILL} border-bad/50 font-semibold text-bad hover:bg-surface`}
        onClick={() => void connectPrincipal()}
        title={p.message}
      >
        <ShieldAlert aria-hidden className="size-4" />
        Principal unreachable · retry
      </button>
    );
  const busy = p.status === "connecting";
  return (
    <button
      type="button"
      className={`${PILL} font-semibold hover:bg-surface hover:shadow-lift disabled:opacity-60`}
      disabled={busy}
      onClick={() => void connectPrincipal()}
      title="Ask the principal signer which key will sign your mandates"
    >
      <KeyRound aria-hidden className="size-4 text-signal" />
      {busy ? "Connecting..." : "Connect principal"}
    </button>
  );
}
