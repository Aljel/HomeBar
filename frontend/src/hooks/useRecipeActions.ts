import { useState } from "react";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { api, errorMessage } from "../api/client";
import { keys } from "../api/queries";
import type { Availability, LocalRecipe, Paged, Recipe, RecipeSummary } from "../api/types";
import { toastError, toastSuccess } from "../lib/toast";

/** Favourite toggle with optimistic updates in the recipe cache and every cached list. */
export function useToggleFavorite() {
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<number | null>(null);

  async function toggle(id: number, next: boolean) {
    setBusyId(id);
    const prevRecipe = qc.getQueryData<LocalRecipe>(keys.recipe(id));
    const patchLists = (fav: boolean) => {
      const patch = (r: RecipeSummary) => (r.id === id ? { ...r, favorite: fav } : r);
      // ["recipes"] holds plain arrays (useRecipes) and infinite pages (usePagedRecipes)
      qc.setQueriesData<RecipeSummary[] | InfiniteData<Paged<RecipeSummary>>>({ queryKey: keys.recipesAll }, (old) => {
        if (!old) return old;
        if (Array.isArray(old)) return old.map(patch);
        return { ...old, pages: old.pages.map((p) => ({ ...p, items: p.items.map(patch) })) };
      });
      qc.setQueriesData<InfiniteData<Paged<Availability>>>({ queryKey: [...keys.availableAll, "list"] }, (old) =>
        old ? { ...old, pages: old.pages.map((p) => ({ ...p, items: p.items.map((a) => ({ ...a, recipe: patch(a.recipe) })) })) } : old,
      );
    };
    if (prevRecipe) qc.setQueryData<LocalRecipe>(keys.recipe(id), { ...prevRecipe, favorite: next });
    patchLists(next);
    try {
      const r = await api.setFavorite(id, next);
      qc.setQueryData(keys.recipe(id), r);
      qc.invalidateQueries({ queryKey: keys.recipesAll });
      qc.invalidateQueries({ queryKey: keys.stats });
      qc.invalidateQueries({ queryKey: keys.menus });
      qc.invalidateQueries({ queryKey: keys.availableAll });
      toastSuccess(next ? "Добавлено в избранное." : "Убрано из избранного.");
    } catch (e) {
      if (prevRecipe) qc.setQueryData(keys.recipe(id), prevRecipe);
      patchLists(!next);
      toastError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  }
  return { toggle, busyId };
}

/** Saves an internet recipe locally and marks every cached discover result as saved. */
export function useImport() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  async function importRecipe(r: Recipe) {
    if (!r.sourceId) return;
    setBusy(r.sourceId);
    try {
      const saved = await api.discoverImport(r.source, r.sourceId);
      const mark = (x: Recipe) => (x.source === r.source && x.sourceId === r.sourceId ? { ...x, importedId: saved.id } : x);
      qc.setQueriesData<Recipe[] | Recipe>({ queryKey: ["discover"] }, (old) =>
        old === undefined ? old : Array.isArray(old) ? old.map(mark) : mark(old),
      );
      qc.setQueryData(keys.recipe(saved.id), saved);
      qc.invalidateQueries({ queryKey: keys.recipesAll });
      qc.invalidateQueries({ queryKey: keys.stats });
      qc.invalidateQueries({ queryKey: keys.tags });
      qc.invalidateQueries({ queryKey: keys.availableAll });
      qc.invalidateQueries({ queryKey: keys.pantrySuggestionsAll });
      toastSuccess(`«${saved.title}» сохранён в ваши рецепты.`);
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return { busy, importRecipe };
}
