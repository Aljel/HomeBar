import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { keys, PANTRY_STALE } from "../api/queries";
import type { LocalRecipe, MissingIngredient } from "../api/types";
import { stockOf, type RecipeStock } from "../lib/stock";

/**
 * Which ingredients of a recipe the pantry covers — for the host's recipe page.
 *
 * Choice: ask the server instead of re-implementing matching. The parent/child rule
 * ("rum" satisfies "light rum" and vice versa) and staples live in the backend catalog,
 * which the frontend never sees in full, so:
 *  1. `GET /api/available?q=<title>&kind=<kind>&maxMissing=5` and pick this recipe's row — one cheap
 *     request that returns the exact server-side `missing` list;
 *  2. only if the recipe is not there (more than 5 missing), ask `GET /api/ingredients?q=<name>`
 *     per ingredient and read the catalog's `inPantry` flag (also server-computed, parent rule included).
 * Cached under ["available", …] so every pantry change refreshes it.
 */
export function useRecipeAvailability(recipe: LocalRecipe, enabled: boolean) {
  const keyed = recipe.ingredients.some((i) => i.key);
  return useQuery({
    queryKey: [...keys.availableAll, "recipe", recipe.id, recipe.updatedAt] as const,
    enabled: enabled && keyed,
    staleTime: PANTRY_STALE,
    queryFn: async ({ signal }): Promise<RecipeStock> => {
      const kind = recipe.kind === "dish" || recipe.kind === "cocktail" ? recipe.kind : undefined;
      const page = await api.available({ kind, maxMissing: 5, q: recipe.title }, 60, 0, signal);
      const row = page.items.find((a) => a.recipe.id === recipe.id);
      if (row) return stockOf(recipe.ingredients, row.missing);

      // fallback: per-ingredient catalog lookups
      const missing: MissingIngredient[] = [];
      const seen = new Set<string>();
      await Promise.all(
        recipe.ingredients.map(async (ing) => {
          const key = ing.key;
          if (!key || seen.has(key)) return;
          seen.add(key);
          const found = (await api.ingredients(ing.name, 10, signal)).find((c) => c.key === key);
          if (!found?.inPantry) missing.push({ key, name: found?.name ?? ing.name });
        }),
      );
      return stockOf(recipe.ingredients, missing);
    },
  });
}
