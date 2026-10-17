import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WordButton } from "@/components/ui/word-button";
import { exceedsAvailable, parseCeiling, presetsFor, sliderBounds } from "../lib/ceiling.js";
import { fromMinor } from "../lib/money.js";
import { Note } from "./Note.js";

/**
 * The spending ceiling of the mandate being reviewed: amount input, slider up to the funds available to delegate,
 * and presets. Above the available funds it only warns; signing stays allowed (the hard limits are enforced by the signer).
 */
export function CeilingField(props: {
  value: string;
  onChange: (text: string) => void;
  precision: number;
  perTask: string;
  /** available_to_delegate from GET /api/funds; null when no principal is connected or the funds are unknown. */
  available: string | null;
}) {
  const id = useId();
  const minor = parseCeiling(props.value, props.precision);
  const bounds = sliderBounds(props.available, minor ?? 0n, props.precision);
  const over = minor !== null && exceedsAvailable(minor, props.available, props.precision);
  const presets = presetsFor(props.perTask, props.precision);
  return (
    <div className="grid gap-3 border-y border-rule py-3" data-testid="ceiling-field">
      <Label htmlFor={id} className="text-sm text-subtle uppercase">
        Spending ceiling (tUSD)
      </Label>
      <div className="flex flex-wrap items-center gap-4">
        <Input
          id={id}
          inputMode="decimal"
          value={props.value}
          aria-invalid={minor === null}
          onChange={(e) => props.onChange(e.target.value)}
          className="w-40 font-mono text-2xl font-semibold"
        />
        <input
          type="range"
          aria-label="Spending ceiling slider"
          min={0}
          max={bounds.max}
          step={bounds.step}
          value={bounds.position(minor)}
          disabled={bounds.max === 0}
          onChange={(e) => props.onChange(fromMinor(BigInt(e.target.value), props.precision))}
          className="min-w-48 flex-1 accent-ink"
        />
      </div>
      {props.available !== null && (
        <p className="text-base text-subtle">
          Available to delegate: <span className="font-mono">{props.available}</span> tUSD
        </p>
      )}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-sm text-subtle uppercase">Enough for</span>
        {presets.map((p) => (
          <WordButton key={p.tasks} onClick={() => props.onChange(p.total)}>
            {p.label} → {p.total}
          </WordButton>
        ))}
      </div>
      {minor === null && (
        <p role="alert" className="font-semibold">
          <span aria-hidden>▲ </span>
          Enter an amount above zero with at most {props.precision} decimals.
        </p>
      )}
      {over && (
        <Note title="More than you can delegate right now">
          <p>
            {props.value} tUSD is above the {props.available} tUSD available. You can still sign; a
            payment is refused if the channel cannot cover it.
          </p>
        </Note>
      )}
      <p className="text-base text-subtle">
        Signing sets a spending limit. No funds move until a task is paid.
      </p>
    </div>
  );
}
