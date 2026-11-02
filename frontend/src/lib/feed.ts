/** Composition of the home feed: own recipes with "from the internet" ideas mixed in. */

export type FeedEntry<A, B> = { type: "own"; item: A } | { type: "idea"; item: B };

/**
 * Puts one idea after every `every` own items; ideas left over once own items run out
 * are appended at the end (that is where "Ещё идеи" adds more).
 */
export function interleave<A, B>(own: readonly A[], ideas: readonly B[], every = 4): FeedEntry<A, B>[] {
  const out: FeedEntry<A, B>[] = [];
  let k = 0;
  own.forEach((item, i) => {
    out.push({ type: "own", item });
    if (every > 0 && (i + 1) % every === 0 && k < ideas.length) out.push({ type: "idea", item: ideas[k++]! });
  });
  for (; k < ideas.length; k++) out.push({ type: "idea", item: ideas[k]! });
  return out;
}

/** Keeps the first occurrence of each key (random batches can repeat a recipe). */
export function uniqueBy<T>(items: readonly T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((t) => {
    const k = key(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export type FeedFilter = "all" | "makeable" | "cocktails" | "dishes" | "favorites" | "mine" | "ideas";

export const FEED_FILTERS: readonly { value: FeedFilter; label: string; host?: true }[] = [
  { value: "all", label: "Всё" },
  { value: "makeable", label: "Можно приготовить", host: true },
  { value: "cocktails", label: "Коктейли" },
  { value: "dishes", label: "Блюда" },
  { value: "favorites", label: "Избранное" },
  { value: "mine", label: "Мои" },
  { value: "ideas", label: "Из интернета" },
];

export function parseFeedFilter(v: string | null): FeedFilter {
  return FEED_FILTERS.some((f) => f.value === v) ? (v as FeedFilter) : "all";
}

type SegmentFilter = { kind?: "cocktail" | "dish"; favorite?: true; source?: "own" | "imported" };

export interface FeedPlan {
  /** own recipes query, or null when the filter shows only ideas */
  own: { kind?: "cocktail" | "dish"; favorite?: true; source?: "own" } | null;
  /** which kind of internet ideas to mix in, or null for none */
  ideas: "cocktail" | "dish" | null;
  /** host: show only what can be made from the pantry (`/api/available`) instead of `own` */
  makeable?: true;
}

/**
 * The feed reads saved recipes page by page in segments, so with a big imported library the
 * host's own work stays on top: favourites first, then own recipes, then everything imported.
 * (Ids repeated by a later segment are dropped when the pages are flattened.)
 */
export function feedSegments(own: FeedPlan["own"]): SegmentFilter[] {
  if (own === null) return [];
  if (own.favorite || own.source) return [own];
  return [
    { ...own, favorite: true },
    { ...own, source: "own" },
    { ...own, source: "imported" },
  ];
}

export function feedPlan(f: FeedFilter): FeedPlan {
  switch (f) {
    case "cocktails":
      return { own: { kind: "cocktail" }, ideas: "cocktail" };
    case "dishes":
      return { own: { kind: "dish" }, ideas: "dish" };
    case "favorites":
      return { own: { favorite: true }, ideas: null };
    case "mine":
      return { own: { source: "own" }, ideas: null };
    case "ideas":
      return { own: null, ideas: "cocktail" };
    case "makeable":
      return { own: null, ideas: null, makeable: true };
    default:
      return { own: {}, ideas: "cocktail" };
  }
}
