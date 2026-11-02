/** Pure helpers for the pantry («Продукты») and availability views. */
import type { IngredientCategory, MissingIngredient } from "../api/types";
import { plural } from "./format";

export const MAX_NAME_LEN = 80;
export const MAX_NAMES_PER_POST = 100;

/** Same normalisation the backend applies before matching (trim, lower-case, ё→е, single spaces). */
export function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
}

/** True when the text holds several products (comma, semicolon or newline separated). */
export function isList(text: string): boolean {
  return /[,;\n\r]/.test(text);
}

/**
 * Text typed or pasted into the pantry input → product names.
 * Splits on commas, semicolons and newlines; strips list bullets ("- ", "• ", "1. ", "2) "),
 * checkboxes and trailing dots; drops empties and case/ё-insensitive duplicates; caps the length.
 */
export function parseNames(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[,;\n\r]+/)) {
    const name = raw
      .replace(/^\s*(?:[-–—•*·▪●○✓✔☐☑]|\[[ xX]?\]|\d{1,3}[.)])\s*/u, "")
      .replace(/[.。]+\s*$/u, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_NAME_LEN)
      .trim();
    if (!name) continue;
    const k = normalizeName(name);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(name);
    if (out.length >= MAX_NAMES_PER_POST) break;
  }
  return out;
}

/** Display order of categories: bar first, then kitchen. */
export const CATEGORY_ORDER: readonly IngredientCategory[] = [
  "spirits",
  "liqueurs",
  "wine",
  "beer",
  "bitters",
  "syrups",
  "mixers",
  "juices",
  "fruits",
  "herbs",
  "vegetables",
  "eggs",
  "dairy",
  "meat",
  "fish",
  "grains",
  "bakery",
  "spices",
  "sauces",
  "oils",
  "sweets",
  "nuts",
  "other",
];

export const CATEGORY_LABEL: Record<IngredientCategory, string> = {
  spirits: "Крепкий алкоголь",
  liqueurs: "Ликёры",
  wine: "Вино и вермут",
  beer: "Пиво и сидр",
  mixers: "Газировка и миксеры",
  juices: "Соки",
  syrups: "Сиропы",
  bitters: "Биттеры",
  fruits: "Фрукты и ягоды",
  vegetables: "Овощи",
  herbs: "Зелень и травы",
  spices: "Специи и соль",
  dairy: "Молочное",
  eggs: "Яйца",
  meat: "Мясо и птица",
  fish: "Рыба и морепродукты",
  grains: "Крупы, мука, макароны",
  bakery: "Хлеб и выпечка",
  sauces: "Соусы и приправы",
  oils: "Масла и жиры",
  sweets: "Сладкое",
  nuts: "Орехи и семена",
  other: "Прочее",
};

/** Russian title for a category; unknown values (newer backend) fall into «Прочее». */
export function categoryLabel(c: string): string {
  return (CATEGORY_LABEL as Record<string, string>)[c] ?? CATEGORY_LABEL.other;
}

function categoryRank(c: string): number {
  const i = CATEGORY_ORDER.indexOf(c as IngredientCategory);
  return i === -1 ? CATEGORY_ORDER.length - 1 : i;
}

const collator = new Intl.Collator("ru", { sensitivity: "base" });

export interface CategoryGroup<T> {
  category: IngredientCategory;
  label: string;
  items: T[];
}

/** Groups products by category in `CATEGORY_ORDER`, names sorted alphabetically (ru) inside. */
export function groupByCategory<T extends { category: string; name: string }>(items: readonly T[]): CategoryGroup<T>[] {
  const map = new Map<IngredientCategory, T[]>();
  for (const it of items) {
    const c = categoryRank(it.category) === CATEGORY_ORDER.length - 1 ? "other" : (it.category as IngredientCategory);
    const list = map.get(c);
    if (list) list.push(it);
    else map.set(c, [it]);
  }
  return [...map.entries()]
    .sort((a, b) => categoryRank(a[0]) - categoryRank(b[0]))
    .map(([category, list]) => ({
      category,
      label: CATEGORY_LABEL[category],
      items: list.slice().sort((a, b) => collator.compare(a.name, b.name)),
    }));
}

const MISSING_WORDS = ["одного", "двух", "трёх", "четырёх", "пяти"];

/** «Всё есть», «Не хватает одного», «Не хватает двух»… */
export function missingGroupTitle(n: number): string {
  if (n <= 0) return "Всё есть";
  return `Не хватает ${MISSING_WORDS[n - 1] ?? n}`;
}

export interface MissingGroup<T> {
  missing: number;
  title: string;
  items: T[];
}

/**
 * Groups availability rows by their number of missing ingredients (ascending).
 * Order inside a group is kept as given (the API already sorts favourites/own first).
 */
export function groupByMissing<T extends { missing: readonly unknown[] }>(items: readonly T[]): MissingGroup<T>[] {
  const map = new Map<number, T[]>();
  for (const it of items) {
    const n = it.missing.length;
    const list = map.get(n);
    if (list) list.push(it);
    else map.set(n, [it]);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([missing, list]) => ({ missing, title: missingGroupTitle(missing), items: list }));
}

/** "нет: лайм, мята" — for guests. */
export function missingLine(missing: readonly MissingIngredient[]): string {
  return missing.length ? `нет: ${missing.map((m) => m.name.toLowerCase()).join(", ")}` : "";
}

export function productCount(n: number): string {
  return `${n} ${plural(n, ["продукт", "продукта", "продуктов"])}`;
}

export function recipeCount(n: number): string {
  return `${n} ${plural(n, ["рецепт", "рецепта", "рецептов"])}`;
}

/** "Добавлено: лайм, мята" / "Уже есть: лайм" — the inline confirmation after an add. */
export function addedMessage(added: readonly string[], already: readonly string[]): string {
  const parts: string[] = [];
  const list = (xs: readonly string[]) => {
    const shown = xs.slice(0, 6).map((x) => x.toLowerCase());
    return xs.length > 6 ? `${shown.join(", ")} и ещё ${xs.length - 6}` : shown.join(", ");
  };
  if (added.length) parts.push(`Добавлено: ${list(added)}`);
  if (already.length) parts.push(`${added.length ? "уже было" : "Уже есть"}: ${list(already)}`);
  return parts.join(" · ");
}

export interface QuickSet {
  id: string;
  label: string;
  names: readonly string[];
}

export const QUICK_SETS: readonly QuickSet[] = [
  {
    id: "kitchen",
    label: "Базовое на кухне",
    names: ["соль", "сахар", "чёрный перец", "растительное масло", "сливочное масло", "яйца", "мука", "лук", "чеснок"],
  },
  {
    id: "bar",
    label: "Бар: основа",
    names: ["лимон", "лайм", "сахарный сироп", "содовая", "тоник", "апельсин", "мята", "ангостура"],
  },
];

/**
 * Names of a quick set that are not in the pantry yet (by Russian or English display name).
 * The backend also ignores duplicates by key, so a name that resolves to an existing key is harmless.
 */
export function missingFromSet(set: QuickSet, pantry: readonly { name: string; nameEn: string }[]): string[] {
  const have = new Set<string>();
  for (const p of pantry) {
    have.add(normalizeName(p.name));
    have.add(normalizeName(p.nameEn));
  }
  return set.names.filter((n) => !have.has(normalizeName(n)));
}

/** Should the first autocomplete option be pre-highlighted? Only when it really continues what was typed. */
export function suggestionMatches(typed: string, option: { name: string; nameEn: string }): boolean {
  const t = normalizeName(typed);
  if (!t) return false;
  return normalizeName(option.name).startsWith(t) || normalizeName(option.nameEn).startsWith(t);
}
