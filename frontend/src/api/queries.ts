import { QueryClient, keepPreviousData, useInfiniteQuery, useQuery, type InfiniteData } from "@tanstack/react-query";
import { api, isApiError } from "./client";
import type { AvailableFilters, DiscoverKind, LibrarySyncStatus, Paged, RecipeFilters, RecipeSummary, Settings } from "./types";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      retry: (count, err) => !(isApiError(err) && err.status >= 400 && err.status < 500) && count < 2,
    },
    mutations: { retry: false },
  },
});

export const keys = {
  stats: ["stats"] as const,
  tags: ["tags"] as const,
  recipes: (f: RecipeFilters) => ["recipes", f] as const,
  recipesAll: ["recipes"] as const,
  recipe: (id: number) => ["recipe", id] as const,
  versions: (id: number) => ["recipe", id, "versions"] as const,
  version: (id: number, vid: number) => ["recipe", id, "versions", vid] as const,
  menus: ["menus"] as const,
  menu: (id: number) => ["menus", id] as const,
  activeMenu: ["menus", "active"] as const,
  page: (slug: string) => ["page", slug] as const,
  discoverRandom: (kind: DiscoverKind, nonce: number) => ["discover", "random", kind, nonce] as const,
  discoverSearch: (q: string, kind: DiscoverKind) => ["discover", "search", kind, q] as const,
  discoverLookup: (source: string, sourceId: string) => ["discover", "lookup", source, sourceId] as const,
  orders: (status: "active" | "all") => ["orders", status] as const,
  order: (id: number) => ["order", id] as const,
  // v2 — everything derived from the pantry lives under these prefixes
  recipesPaged: (segments: readonly RecipeFilters[], pageSize: number) => ["recipes", "paged", segments, pageSize] as const,
  ingredientsAll: ["ingredients"] as const,
  ingredients: (q: string) => ["ingredients", q] as const,
  pantry: ["pantry"] as const,
  pantrySuggestionsAll: ["pantry-suggestions"] as const,
  pantrySuggestions: (kind: DiscoverKind) => ["pantry-suggestions", kind] as const,
  availableAll: ["available"] as const,
  available: (f: AvailableFilters, pageSize: number) => ["available", "list", f, pageSize] as const,
  availableCount: (f: AvailableFilters) => ["available", "count", f] as const,
  settings: ["settings"] as const,
  librarySync: ["library-sync"] as const,
};

/**
 * The pantry changed: refresh everything computed from it (availability, suggestions,
 * catalog `inPantry` flags, `missing` on curated menu items) and the pantry itself.
 */
export function invalidatePantryDerived(qc: QueryClient = queryClient): void {
  qc.invalidateQueries({ queryKey: keys.pantry });
  qc.invalidateQueries({ queryKey: keys.availableAll });
  qc.invalidateQueries({ queryKey: keys.pantrySuggestionsAll });
  qc.invalidateQueries({ queryKey: keys.ingredientsAll });
  // ["menus"] covers the active menu and every menu by id (their items carry `missing`)
  qc.invalidateQueries({ queryKey: keys.menus });
}

/** New recipes arrived in bulk (library sync): lists, counters and availability are stale. */
export function invalidateRecipeLists(qc: QueryClient = queryClient): void {
  qc.invalidateQueries({ queryKey: keys.recipesAll });
  qc.invalidateQueries({ queryKey: keys.stats });
  qc.invalidateQueries({ queryKey: keys.tags });
  qc.invalidateQueries({ queryKey: keys.availableAll });
  qc.invalidateQueries({ queryKey: keys.pantrySuggestionsAll });
  qc.invalidateQueries({ queryKey: keys.ingredientsAll });
}

export const useStats = () => useQuery({ queryKey: keys.stats, queryFn: ({ signal }) => api.stats(signal) });

export const useTags = () =>
  useQuery({ queryKey: keys.tags, queryFn: ({ signal }) => api.tags(signal), staleTime: 60_000 });

export const useRecipes = (f: RecipeFilters, enabled = true) =>
  useQuery({
    queryKey: keys.recipes(f),
    queryFn: ({ signal }) => api.recipes(f, signal),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useRecipe = (id: number) =>
  useQuery({ queryKey: keys.recipe(id), queryFn: ({ signal }) => api.recipe(id, signal), enabled: id > 0 });

export const useVersions = (id: number, enabled: boolean) =>
  useQuery({ queryKey: keys.versions(id), queryFn: ({ signal }) => api.versions(id, signal), enabled });

export const useVersion = (id: number, vid: number | null) =>
  useQuery({
    queryKey: keys.version(id, vid ?? 0),
    queryFn: ({ signal }) => api.version(id, vid ?? 0, signal),
    enabled: vid !== null,
    staleTime: Infinity,
  });

export const useMenus = (enabled = true) =>
  useQuery({ queryKey: keys.menus, queryFn: ({ signal }) => api.menus(signal), enabled });

export const useMenu = (id: number | null) =>
  useQuery({
    queryKey: keys.menu(id ?? 0),
    queryFn: ({ signal }) => api.menu(id ?? 0, signal),
    enabled: id !== null,
  });

/** Active menu; resolves to null (not an error) when there is none (404). */
export const useActiveMenu = () =>
  useQuery({
    queryKey: keys.activeMenu,
    queryFn: async ({ signal }) => {
      try {
        return await api.activeMenu(signal);
      } catch (e) {
        if (isApiError(e, 404)) return null;
        throw e;
      }
    },
    refetchInterval: 60_000,
  });

/** Page by slug; null when missing (404). */
export const usePage = (slug: string) =>
  useQuery({
    queryKey: keys.page(slug),
    queryFn: async ({ signal }) => {
      try {
        return await api.page(slug, signal);
      } catch (e) {
        if (isApiError(e, 404)) return null;
        throw e;
      }
    },
  });

// ---------- v2 ----------

export const PANTRY_STALE = 15_000;

export const usePantry = (enabled = true) =>
  useQuery({ queryKey: keys.pantry, queryFn: ({ signal }) => api.pantry(signal), staleTime: PANTRY_STALE, enabled });

/** Autocomplete over the ingredient catalog; `q` should already be debounced. */
export const useIngredientSearch = (q: string, enabled = true) =>
  useQuery({
    queryKey: keys.ingredients(q),
    queryFn: ({ signal }) => api.ingredients(q, 8, signal),
    enabled: enabled && q.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

export const usePantrySuggestions = (kind: DiscoverKind, enabled = true) =>
  useQuery({
    queryKey: keys.pantrySuggestions(kind),
    queryFn: ({ signal }) => api.pantrySuggestions(kind, 12, signal),
    staleTime: PANTRY_STALE,
    enabled,
  });

/** Infinite list of what can be made (sorted by the API: fewest missing first). */
export const useAvailable = (f: AvailableFilters, pageSize = 30, enabled = true) =>
  useInfiniteQuery({
    queryKey: keys.available(f, pageSize),
    queryFn: ({ signal, pageParam }) => api.available(f, pageSize, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return last.items.length > 0 && loaded < last.total ? loaded : undefined;
    },
    placeholderData: keepPreviousData,
    staleTime: PANTRY_STALE,
    enabled,
  });

/** Just the number of matches (one-row request, reads X-Total-Count). */
export const useAvailableCount = (f: AvailableFilters, enabled = true) =>
  useQuery({
    queryKey: keys.availableCount(f),
    queryFn: async ({ signal }) => (await api.available(f, 1, 0, signal)).total,
    staleTime: PANTRY_STALE,
    enabled,
  });

export const DEFAULT_SETTINGS: Settings = { guestMaxMissing: 0, guestShowMenu: true };

export const useSettings = () =>
  useQuery({ queryKey: keys.settings, queryFn: ({ signal }) => api.settings(signal), staleTime: 60_000 });

export const useLibrarySync = (enabled = true) =>
  useQuery<LibrarySyncStatus>({
    queryKey: keys.librarySync,
    queryFn: ({ signal }) => api.librarySyncStatus(signal),
    refetchInterval: (q) => (q.state.data?.running ? 1500 : false),
    enabled,
  });

type SegmentParam = { seg: number; offset: number };

/**
 * Recipes in pages, read from several filtered "segments" one after another
 * (e.g. favourites → own → imported), so the important ones come first even in a 1400-recipe base.
 * Ids already shown by an earlier segment are dropped by `flattenRecipePages`.
 */
export const usePagedRecipes = (segments: readonly RecipeFilters[], pageSize = 40, enabled = true) =>
  useInfiniteQuery({
    queryKey: keys.recipesPaged(segments, pageSize),
    queryFn: async ({ signal, pageParam }): Promise<Paged<RecipeSummary> & SegmentParam> => {
      const f = segments[pageParam.seg] ?? {};
      const page = await api.recipesPage(f, pageSize, pageParam.offset, signal);
      return { ...page, ...pageParam };
    },
    initialPageParam: { seg: 0, offset: 0 } as SegmentParam,
    getNextPageParam: (last): SegmentParam | undefined => {
      const next = last.offset + last.items.length;
      if (last.items.length > 0 && next < last.total) return { seg: last.seg, offset: next };
      return last.seg + 1 < segments.length ? { seg: last.seg + 1, offset: 0 } : undefined;
    },
    placeholderData: keepPreviousData,
    enabled,
  });

/** Pages → one list without duplicates (segments may overlap, pages may shift while loading). */
export function flattenRecipePages(data: InfiniteData<Paged<RecipeSummary>, unknown> | undefined): RecipeSummary[] {
  if (!data) return [];
  const seen = new Set<number>();
  const out: RecipeSummary[] = [];
  for (const p of data.pages)
    for (const r of p.items) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
  return out;
}
