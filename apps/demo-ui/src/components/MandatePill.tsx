import type { RootCapability } from "@verdict/protocol";
import { useEffect, useState } from "react";
import { WordButton } from "@/components/ui/word-button";

export type MandateStatus = "none" | "active" | "expired";

export function mandateStatus(root: RootCapability | null, now: number): MandateStatus {
  if (!root) return "none";
  return Date.parse(root.expires_at) > now ? "active" : "expired";
}

export function timeLeft(expiresAt: string, now: number): string {
  const mins = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 60000));
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h ${mins % 60}m left` : `${mins}m left`;
}

export function MandatePill(props: { root: RootCapability | null; onClick: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const st = mandateStatus(props.root, now);
  const text =
    st === "active" && props.root
      ? `Mandate · ${timeLeft(props.root.expires_at, now)}`
      : st === "expired"
        ? "Mandate expired"
        : "No mandate";
  return (
    <WordButton
      onClick={props.onClick}
      title="Show the rules of this mandate (m)"
      className={st === "active" ? "" : "font-semibold decoration-2 decoration-ink"}
    >
      <span aria-hidden>{st === "active" ? "■" : "▲"} </span>
      <span className="hidden min-[1440px]:inline">{text}</span>
      <span className="min-[1440px]:hidden">{text.replace(/(\d+h) (\d+m)/, "$1$2")}</span>
    </WordButton>
  );
}
