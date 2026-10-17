import { Ban, CheckCircle2, Hourglass, Loader2, Lock, RotateCcw, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { Chip } from "../lib/view.js";

type Variant = "info" | "warn" | "ok" | "danger" | "neutral";
const CHIP: Record<Chip, { Icon: typeof Lock; variant: Variant }> = {
  Working: { Icon: Loader2, variant: "info" },
  Locked: { Icon: Lock, variant: "warn" },
  Verifying: { Icon: ShieldCheck, variant: "info" },
  "Refund pending": { Icon: Hourglass, variant: "warn" },
  Paid: { Icon: CheckCircle2, variant: "ok" },
  Refunded: { Icon: RotateCcw, variant: "info" },
  Expired: { Icon: Hourglass, variant: "neutral" },
  Blocked: { Icon: Ban, variant: "danger" },
};

/** Status of a task: icon + word + one semantic colour, never colour alone. */
export function StatusChip({ chip }: { chip: Chip }) {
  const { Icon, variant } = CHIP[chip];
  return (
    <Badge variant={variant}>
      <Icon aria-hidden className="size-4!" />
      {chip}
    </Badge>
  );
}
