/**
 * Placeholder art for recipes without a photo: which outline drawing to show
 * (by the glass name, or guessed from kind/title/ingredients) and a soft tint derived from the id.
 */

export type GlassKind = "rocks" | "coupe" | "martini" | "highball" | "wine" | "mug" | "shot" | "plate" | "bowl";

const NAME_RULES: readonly [RegExp, GlassKind][] = [
  [/mug|cup|кружк|чашк|irish|кофе|coffee|toddy/, "mug"],
  [/shot|шот|рюмк|shooter/, "shot"],
  [/martini|мартини|cocktail glass|коктейльн|nick/, "martini"],
  [/coupe|купе|margarita|маргарит|сауэр|sour glass/, "coupe"],
  [/wine|вин|champagne|шампан|flute|флют|snifter|сниф|balloon|баллон|cordial|brandy|бренди|копа|copa/, "wine"],
  [/highball|хайбол|collins|коллинз|pint|пинт|beer|пив|jar|hurricane|харрикейн|pilsner|tall|zombie|зомби|стакан/, "highball"],
  [/rocks|рокс|old.?fashioned|олд|tumbler|тумблер|whisk|виск|lowball/, "rocks"],
  [/bowl|миск|тарелк.*глуб|soup/, "bowl"],
  [/plate|тарелк|блюд/, "plate"],
];

/** Maps a free-form glass name ("Рокс", "Highball glass", "Coffee mug") to a drawing; null if unknown. */
export function glassFromName(glass: string | null | undefined): GlassKind | null {
  const g = (glass ?? "").trim().toLowerCase();
  if (!g) return null;
  for (const [re, kind] of NAME_RULES) if (re.test(g)) return kind;
  return null;
}

const DRINK_HINTS: readonly [RegExp, GlassKind][] = [
  [/кофе|coffee|грог|grog|глинтв|mulled|какао|cocoa|\bчай|\btea\b|toddy|тодди|пунш горяч|hot /, "mug"],
  [/\bшот|\bshot|shooter|б-52|b-52/, "shot"],
  [/шприц|spritz|просекко|prosecco|шампан|champagne|игрист|sangria|сангри|kir|кир рояль|mimosa|мимоз|bellini|беллини/, "wine"],
  [/мартини|martini|космополит|cosmopolitan|манхэттен|manhattan|vesper|веспер/, "martini"],
  [/дайкири|daiquiri|маргарит|margarita|гимлет|gimlet|сайдкар|sidecar|клевер|clover|авиац|aviation|ласт ворд|last word/, "coupe"],
  [/мохито|mojito|тоник|tonic|содов|soda|газиров|кола\b|cola|имбирн|ginger beer|ginger ale|хайбол|highball|collins|коллинз|физз|fizz|\bмул|mule|лонг айленд|long island|пина колад|pina colada|зомби|zombie/, "highball"],
];

const DISH_BOWL = /суп|soup|салат|salad|гуакамоле|guacamole|соус|dip|рагу|stew|каша|porridge|боул|bowl|рамен|ramen|паст[аы]|pasta|ризотто|risotto|карри|curry|шакшук|shakshuka|чили/;

export interface GlassHints {
  kind: "cocktail" | "dish" | "other";
  glass?: string | null;
  title?: string;
  ingredientNames?: readonly string[];
}

/** Best drawing for a recipe: explicit glass name first, then a guess from what's in it. */
export function guessGlass(h: GlassHints): GlassKind {
  const byName = glassFromName(h.glass);
  if (byName) return byName;
  const text = `${h.title ?? ""} ${(h.ingredientNames ?? []).join(" ")}`.toLowerCase();
  if (h.kind === "dish") return DISH_BOWL.test(text) ? "bowl" : "plate";
  for (const [re, kind] of DRINK_HINTS) if (re.test(text)) return kind;
  return h.kind === "other" ? "mug" : "rocks";
}

function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface Tint {
  bg: string;
  ink: string;
}

/** Very light green / sand backgrounds with a matching line colour (AA-ish against the bg). */
export const TINTS: readonly Tint[] = [
  { bg: "#e8eee5", ink: "#3f5b47" },
  { bg: "#f2eadf", ink: "#7a5a3c" },
  { bg: "#ecebe2", ink: "#4f5a43" },
  { bg: "#f3e8e1", ink: "#86533f" },
  { bg: "#e5ece9", ink: "#3d5551" },
  { bg: "#efe9dc", ink: "#6b5a3a" },
];

export function tintFor(seed: string | number): Tint {
  return TINTS[hashString(String(seed)) % TINTS.length] ?? TINTS[0]!;
}
