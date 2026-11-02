import type { UnitSystem } from "../../lib/units";
import { formatNumber } from "../../lib/measure";
import { IconButton } from "../Button";
import "./controls.css";

interface StepperProps {
  value: number;
  base: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}

/** Servings: − 2 + in a thin outline pill. */
export function ServingsStepper({ value, base, onChange, min = 1, max = 50 }: StepperProps) {
  const lo = Math.min(min, base);
  const dec = () => onChange(Math.max(lo, Number.isInteger(value) ? value - 1 : Math.floor(value)));
  const inc = () => onChange(Math.min(max, Number.isInteger(value) ? value + 1 : Math.ceil(value)));
  return (
    <div className="stepper" role="group" aria-label="Количество порций">
      <IconButton icon="minus" label="Меньше порций" look="plain" onClick={dec} disabled={value <= lo} />
      <output className="stepper__value" aria-live="polite" aria-label={`${formatNumber(value)} порц.`}>
        {formatNumber(value)}
        <span className="stepper__unit"> порц.</span>
      </output>
      <IconButton icon="plus" label="Больше порций" look="plain" onClick={inc} disabled={value >= max} />
    </div>
  );
}

/** ml / oz segmented control. */
export function UnitToggle({ value, onChange }: { value: UnitSystem; onChange: (u: UnitSystem) => void }) {
  return (
    <div className="segmented" role="group" aria-label="Единицы объёма">
      <button type="button" className="segmented__btn" aria-pressed={value === "ml"} onClick={() => onChange("ml")}>
        мл
      </button>
      <button type="button" className="segmented__btn" aria-pressed={value === "oz"} onClick={() => onChange("oz")}>
        oz
      </button>
    </div>
  );
}
