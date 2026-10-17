import { WordButton } from "@/components/ui/word-button";
import { connectPrincipal, principalChip } from "../lib/principal.js";
import { useStore } from "../store.js";

/** Header control: "Connect principal" until connected, then a chip with the principal's public id. */
export function PrincipalChip() {
  const p = useStore((s) => s.principal);
  if (p.status === "connected")
    return (
      <span
        className="shrink-0 font-mono text-sm whitespace-nowrap"
        title={`${p.id}\nThe key is held by the principal-signer process, not by this screen.`}
      >
        <span aria-hidden>■ </span>
        {principalChip(p.id)}
      </span>
    );
  if (p.status === "error")
    return (
      <WordButton
        className="shrink-0 font-semibold decoration-2 decoration-ink"
        onClick={() => void connectPrincipal()}
        title={p.message}
      >
        <span aria-hidden>▲ </span>Principal unreachable · retry
      </WordButton>
    );
  return (
    <WordButton
      className="shrink-0"
      disabled={p.status === "connecting"}
      onClick={() => void connectPrincipal()}
      title="Ask the principal signer which key will sign your mandates"
    >
      {p.status === "connecting" ? "Connecting..." : "Connect principal"}
    </WordButton>
  );
}
