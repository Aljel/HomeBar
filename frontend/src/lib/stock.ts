/** Per-ingredient pantry marks for a recipe (host view). Pure. */
import type { Ingredient, MissingIngredient } from "../api/types";

/** Never count as missing (mirrors the backend catalog's `staple: true`). */
export const STAPLES: ReadonlySet<string> = new Set(["water", "ice", "hot water", "cold water", "boiling water"]);

/** have = in pantry, missing = not, staple = water/ice, null = unknown (no key from an old backend) */
export type StockMark = "have" | "missing" | "staple" | null;

export interface RecipeStock {
  /** what to buy, deduplicated by key, staples excluded, recipe order */
  missing: MissingIngredient[];
  /** one mark per ingredient row, same order as `ingredients` */
  marks: StockMark[];
}

export function stockOf(ingredients: readonly Ingredient[], missing: readonly MissingIngredient[]): RecipeStock {
  const missingByKey = new Map(missing.map((m) => [m.key, m]));
  const marks: StockMark[] = ingredients.map((i) => {
    if (!i.key) return null;
    if (STAPLES.has(i.key)) return "staple";
    return missingByKey.has(i.key) ? "missing" : "have";
  });
  const out: MissingIngredient[] = [];
  const seen = new Set<string>();
  for (const m of missing) {
    if (STAPLES.has(m.key) || seen.has(m.key)) continue;
    seen.add(m.key);
    out.push(m);
  }
  return { missing: out, marks };
}
