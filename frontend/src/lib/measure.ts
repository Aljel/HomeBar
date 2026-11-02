import { isConvertibleVolume, normalizeUnit, toMl, type UnitSystem } from "./units";

export interface Measurable {
  amount: number | null;
  unit: string;
}

export interface DisplayMeasure {
  /** Formatted quantity ("1 ½", "22,5") or "" when the amount is unknown. */
  qty: string;
  /** Human unit label ("oz", "мл", "ч. л.") or "". */
  unit: string;
}

const FRACTION_GLYPHS: Readonly<Record<string, string>> = {
  "1/2": "½",
  "1/3": "⅓",
  "2/3": "⅔",
  "1/4": "¼",
  "3/4": "¾",
  "1/8": "⅛",
  "3/8": "⅜",
  "5/8": "⅝",
  "7/8": "⅞",
};

const UNIT_LABELS: Readonly<Record<string, string>> = {
  ml: "мл",
  cl: "сл",
  dl: "дл",
  l: "л",
  oz: "oz",
  tsp: "ч. л.",
  tbsp: "ст. л.",
  dash: "дэш",
  barspoon: "бар. л.",
  shot: "шот",
  g: "г",
  gr: "г",
  gram: "г",
  grams: "г",
  kg: "кг",
  pcs: "шт.",
  pc: "шт.",
  piece: "шт.",
  pieces: "шт.",
  slice: "долька",
  slices: "дольки",
  cup: "стакан",
  cups: "стакана",
  pinch: "щепотка",
};

const numberFmt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

export function formatNumber(n: number): string {
  return numberFmt.format(n);
}

/** Servings multiplier; guards against bad input. */
export function scaleFactor(baseServings: number, targetServings: number): number {
  if (!(baseServings > 0) || !(targetServings > 0)) return 1;
  return targetServings / baseServings;
}

export function scaleAmount(amount: number | null, factor: number): number | null {
  if (amount === null || !Number.isFinite(amount)) return null;
  return amount * factor;
}

/** Bar-friendly millilitre rounding: 0.5 steps below 10 ml, 2.5 below 100 ml, 5 above. */
export function roundMl(ml: number): number {
  const step = ml < 10 ? 0.5 : ml < 100 ? 2.5 : 5;
  const r = Math.round(ml / step) * step;
  return r === 0 && ml > 0 ? step : r;
}

interface Fraction {
  whole: number;
  num: number;
  den: number;
}

/** Best approximation of x by whole + num/den for den in `dens` (smaller den wins ties). */
export function toFraction(x: number, dens: readonly number[]): Fraction {
  const whole = Math.floor(x + 1e-9);
  const frac = x - whole;
  let best: Fraction = { whole, num: 0, den: 1 };
  let bestErr = frac;
  if (1 - frac < bestErr) {
    best = { whole: whole + 1, num: 0, den: 1 };
    bestErr = 1 - frac;
  }
  for (const den of dens) {
    for (let num = 1; num < den; num++) {
      const err = Math.abs(frac - num / den);
      if (err < bestErr - 1e-9) {
        best = { whole, num, den };
        bestErr = err;
      }
    }
  }
  return best;
}

/** "1 ½", "¾", "2". Uses vulgar-fraction glyphs; falls back to decimals when no glyph exists. */
export function formatFraction(x: number, dens: readonly number[] = [2, 3, 4]): string {
  if (x <= 0) return "0";
  const f = toFraction(x, dens);
  // never round a positive amount down to nothing: use the smallest fraction available
  if (f.whole === 0 && f.num === 0) {
    const den = Math.max(...dens);
    return FRACTION_GLYPHS[`1/${den}`] ?? formatNumber(1 / den);
  }
  if (f.num === 0) return String(f.whole);
  const glyph = FRACTION_GLYPHS[`${f.num}/${f.den}`] ?? formatNumber(f.num / f.den).replace(/^0/, "");
  return f.whole > 0 ? `${f.whole}\u2009${glyph}` : glyph;
}

/** Ounces: quarters, eighths for small pours. */
export function formatOz(oz: number): string {
  return oz < 0.5 ? formatFraction(oz, [2, 4, 8]) : formatFraction(oz, [2, 4]);
}

export function unitLabel(unit: string): string {
  const u = normalizeUnit(unit);
  return UNIT_LABELS[u] ?? unit.trim();
}

function formatGeneric(value: number, unit: string): string {
  const u = normalizeUnit(unit);
  if (u === "g" || u === "gr" || u === "gram" || u === "grams" || u === "kg") {
    return value >= 10 ? formatNumber(Math.round(value)) : formatNumber(Math.round(value * 10) / 10);
  }
  if (value >= 10) return formatNumber(Math.round(value));
  // spoons, dashes, pieces, unknown units: kitchen fractions when close, decimals otherwise
  const f = toFraction(value, [2, 3, 4]);
  const approx = f.whole + f.num / f.den;
  if (Math.abs(approx - value) <= 0.06 * Math.max(1, value)) return formatFraction(value);
  return formatNumber(Math.round(value * 10) / 10);
}

/**
 * Formats an ingredient amount for display after scaling by `factor`,
 * converting ml/cl/oz into the chosen unit system.
 */
export function formatMeasure(ing: Measurable, factor: number, system: UnitSystem): DisplayMeasure {
  const scaled = scaleAmount(ing.amount, factor);
  if (scaled === null || scaled <= 0) {
    return { qty: "", unit: ing.amount === null ? "" : unitLabel(ing.unit) };
  }
  if (isConvertibleVolume(ing.unit)) {
    const ml = toMl(scaled, ing.unit) ?? scaled;
    if (system === "oz") return { qty: formatOz(ml / 30), unit: "oz" };
    const r = roundMl(ml);
    return r >= 1000 ? { qty: formatNumber(r / 1000), unit: "л" } : { qty: formatNumber(r), unit: "мл" };
  }
  return { qty: formatGeneric(scaled, ing.unit), unit: unitLabel(ing.unit) };
}

export function measureText(m: DisplayMeasure): string {
  return [m.qty, m.unit].filter(Boolean).join("\u00a0");
}

const GLYPH_VALUES: Readonly<Record<string, number>> = { "½": 0.5, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 0.25, "¾": 0.75, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875 };

/**
 * Parses an amount typed by a human: "45", "0,75", "1/2", "1 1/2", "1½", "¾".
 * Returns null for empty input, NaN for garbage.
 */
export function parseAmount(input: string): number | null {
  const s = input.trim().replace(",", ".");
  if (!s) return null;
  const glyph = s.match(/^(\d+)?\s*([½⅓⅔¼¾⅛⅜⅝⅞])$/);
  if (glyph) return (glyph[1] ? Number(glyph[1]) : 0) + (GLYPH_VALUES[glyph[2]!] ?? 0);
  const mixed = s.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) return Number(frac[2]) === 0 ? Number.NaN : Number(frac[1]) / Number(frac[2]);
  return /^\d*\.?\d+$/.test(s) ? Number(s) : Number.NaN;
}

/** Inverse of parseAmount for editing: 0.5 -> "0.5", 45 -> "45". */
export function amountToInput(n: number | null): string {
  if (n === null) return "";
  return String(Math.round(n * 1000) / 1000);
}
