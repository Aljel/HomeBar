/**
 * Unit handling for ingredient amounts.
 * Liquid units are converted to millilitres for the proportion visual
 * and the ml <-> oz display toggle.
 */

export type UnitSystem = "ml" | "oz";

/** Canonical liquid units and their size in millilitres. */
const LIQUID_ML: Readonly<Record<string, number>> = {
  ml: 1,
  cl: 10,
  dl: 100,
  l: 1000,
  oz: 30,
  tsp: 5,
  tbsp: 15,
  dash: 1,
  barspoon: 5,
  shot: 45,
};

/** Aliases (lower-case, without trailing dots) -> canonical unit. */
const ALIASES: Readonly<Record<string, string>> = {
  мл: "ml",
  milliliter: "ml",
  millilitre: "ml",
  milliliters: "ml",
  millilitres: "ml",
  сл: "cl",
  centiliter: "cl",
  centilitre: "cl",
  л: "l",
  liter: "l",
  litre: "l",
  liters: "l",
  litres: "l",
  ounce: "oz",
  ounces: "oz",
  "fl oz": "oz",
  "fl. oz": "oz",
  floz: "oz",
  унция: "oz",
  унции: "oz",
  teaspoon: "tsp",
  teaspoons: "tsp",
  tspn: "tsp",
  "ч. л": "tsp",
  "ч.л": "tsp",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
  tblsp: "tbsp",
  tbs: "tbsp",
  "ст. л": "tbsp",
  "ст.л": "tbsp",
  dashes: "dash",
  дэш: "dash",
  "bar spoon": "barspoon",
  "bar spoons": "barspoon",
  barspoons: "barspoon",
  "bsp": "barspoon",
  shots: "shot",
  шот: "shot",
  jigger: "shot",
};

/** Normalises a free-form unit string to a canonical key ("Dashes" -> "dash", "oz." -> "oz"). */
export function normalizeUnit(unit: string): string {
  const u = unit.trim().toLowerCase().replace(/\.+$/, "").replace(/\s+/g, " ");
  if (u in LIQUID_ML) return u;
  const alias = ALIASES[u];
  if (alias) return alias;
  // naive plural stripping: "tsps" -> "tsp", "ozs" -> "oz"
  if (u.endsWith("s")) {
    const singular = u.slice(0, -1);
    if (singular in LIQUID_ML) return singular;
    const a2 = ALIASES[singular];
    if (a2) return a2;
  }
  return u;
}

/** Millilitres in one unit, or null when the unit is not a liquid volume. */
export function mlPerUnit(unit: string): number | null {
  return LIQUID_ML[normalizeUnit(unit)] ?? null;
}

export function isLiquidUnit(unit: string): boolean {
  return mlPerUnit(unit) !== null;
}

/** Converts an amount to ml; null when amount is missing or the unit is not liquid. */
export function toMl(amount: number | null, unit: string): number | null {
  if (amount === null || !Number.isFinite(amount) || amount <= 0) return null;
  const k = mlPerUnit(unit);
  return k === null ? null : amount * k;
}

/** Units that the ml/oz toggle converts (spoons and dashes keep their own unit). */
export function isConvertibleVolume(unit: string): boolean {
  const u = normalizeUnit(unit);
  return u === "ml" || u === "cl" || u === "dl" || u === "l" || u === "oz" || u === "shot";
}
