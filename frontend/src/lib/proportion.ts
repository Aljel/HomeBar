import { toMl } from "./units";

export interface ProportionInput {
  name: string;
  amount: number | null;
  unit: string;
}

export interface Part {
  /** index of the ingredient in the original (ordered) list */
  index: number;
  name: string;
  ml: number;
  /** share of total liquid volume, 0..1 */
  share: number;
}

export interface Proportions {
  parts: Part[];
  totalMl: number;
  /** indices of ingredients that are listed but not drawn (non-liquid or unknown amount) */
  undrawn: number[];
}

export function computeProportions(ingredients: readonly ProportionInput[]): Proportions {
  const liquid: { index: number; name: string; ml: number }[] = [];
  const undrawn: number[] = [];
  ingredients.forEach((ing, index) => {
    const ml = toMl(ing.amount, ing.unit);
    if (ml === null) undrawn.push(index);
    else liquid.push({ index, name: ing.name, ml });
  });
  const totalMl = liquid.reduce((s, l) => s + l.ml, 0);
  if (totalMl <= 0) return { parts: [], totalMl: 0, undrawn: ingredients.map((_, i) => i) };
  return { parts: liquid.map((l) => ({ ...l, share: l.ml / totalMl })), totalMl, undrawn };
}

/** Percent label ("38%", "<1%"). */
export function formatShare(share: number): string {
  const p = share * 100;
  if (p > 0 && p < 1) return "<1%";
  return `${Math.round(p)}%`;
}

export interface Layer extends Part {
  /** top edge (smaller y = higher) */
  y: number;
  h: number;
}

/**
 * Stacks parts as horizontal strata from `bottom` up to `top` (first ingredient at the bottom),
 * heights ∝ share. Tiny parts (a dash) get at least `minH` so they stay visible and hoverable;
 * the extra is taken proportionally from the others so the stack still fills exactly.
 */
export function stackLayers(parts: readonly Part[], top: number, bottom: number, minH = 0): Layer[] {
  const total = bottom - top;
  if (parts.length === 0 || total <= 0) return [];
  const raw = parts.map((p) => p.share * total);
  const small = raw.map((h) => h < minH);
  const reserved = small.filter(Boolean).length * minH;
  const bigSum = raw.reduce((s, h, i) => (small[i] ? s : s + h), 0);
  const scale = bigSum > 0 ? Math.max(0, total - reserved) / bigSum : 0;
  let y = bottom;
  return parts.map((p, i) => {
    const h = small[i] ? minH : raw[i]! * scale;
    y -= h;
    return { ...p, y, h };
  });
}
