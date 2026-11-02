const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const timeFmt = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const formatDate = (iso: string | null | undefined) => {
  const d = parse(iso);
  return d ? dateFmt.format(d) : "";
};
export const formatDateTime = (iso: string | null | undefined) => {
  const d = parse(iso);
  return d ? dateTimeFmt.format(d) : "";
};
export const formatTime = (iso: string | null | undefined) => {
  const d = parse(iso);
  return d ? timeFmt.format(d) : "";
};

/** Russian plural: plural(5, ["рецепт", "рецепта", "рецептов"]) */
export function plural(n: number, forms: readonly [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

export function minutesAgo(iso: string, now = Date.now()): string {
  const d = parse(iso);
  if (!d) return "";
  const m = Math.max(0, Math.round((now - d.getTime()) / 60000));
  if (m < 1) return "только что";
  if (m < 60) return `${m} ${plural(m, ["минуту", "минуты", "минут"])} назад`;
  return formatTime(iso);
}

export const KIND_LABEL = { cocktail: "Коктейль", dish: "Блюдо", other: "Другое" } as const;
export const SOURCE_LABEL = { own: "своё", thecocktaildb: "TheCocktailDB", themealdb: "TheMealDB" } as const;
