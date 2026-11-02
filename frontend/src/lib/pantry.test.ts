import { describe, expect, it } from "vitest";
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  QUICK_SETS,
  addedMessage,
  categoryLabel,
  groupByCategory,
  groupByMissing,
  isList,
  missingFromSet,
  missingGroupTitle,
  missingLine,
  normalizeName,
  parseNames,
  productCount,
  suggestionMatches,
} from "./pantry";

describe("parseNames", () => {
  it("splits commas, semicolons and newlines", () => {
    expect(parseNames("лайм, мята;сахар\nсодовая\r\nтоник")).toEqual(["лайм", "мята", "сахар", "содовая", "тоник"]);
  });

  it("returns a single trimmed name for plain text", () => {
    expect(parseNames("  белый   ром  ")).toEqual(["белый ром"]);
  });

  it("strips list bullets, numbering, checkboxes and trailing dots", () => {
    const text = "- джин\n• тоник\n* лайм\n1. лёд\n2) мята.\n[x] сахар\n☐ соль\n— перец";
    expect(parseNames(text)).toEqual(["джин", "тоник", "лайм", "лёд", "мята", "сахар", "соль", "перец"]);
  });

  it("drops empties and case/ё-insensitive duplicates, keeping the first spelling", () => {
    expect(parseNames("Лимон,, лимон ,\n\n ЛИМОН, Чёрный перец, черный перец")).toEqual(["Лимон", "Чёрный перец"]);
  });

  it("keeps hyphens and digits inside names", () => {
    expect(parseNames("7-up, 3 перца, ржано-пшеничный хлеб")).toEqual(["7-up", "3 перца", "ржано-пшеничный хлеб"]);
  });

  it("caps each name at 80 chars and the list at 100 names", () => {
    expect(parseNames("а".repeat(120))[0]).toHaveLength(80);
    const many = Array.from({ length: 150 }, (_, i) => `продукт ${i}`).join(",");
    expect(parseNames(many)).toHaveLength(100);
  });

  it("returns nothing for separators only", () => {
    expect(parseNames(" , ;\n ")).toEqual([]);
  });
});

describe("isList / normalizeName", () => {
  it("detects lists", () => {
    expect(isList("лайм")).toBe(false);
    expect(isList("лайм, мята")).toBe(true);
    expect(isList("лайм\nмята")).toBe(true);
  });
  it("normalises like the backend", () => {
    expect(normalizeName("  Чёрный   Перец ")).toBe("черный перец");
  });
});

describe("groupByMissing", () => {
  const row = (id: number, missing: number) => ({ id, missing: Array.from({ length: missing }, (_, i) => ({ key: `k${i}`, name: `n${i}` })) });

  it("groups ascending by missing count and keeps API order inside a group", () => {
    const groups = groupByMissing([row(1, 0), row(2, 1), row(3, 0), row(4, 2), row(5, 1)]);
    expect(groups.map((g) => g.missing)).toEqual([0, 1, 2]);
    expect(groups[0]!.items.map((r) => r.id)).toEqual([1, 3]);
    expect(groups[1]!.items.map((r) => r.id)).toEqual([2, 5]);
    expect(groups.map((g) => g.title)).toEqual(["Всё есть", "Не хватает одного", "Не хватает двух"]);
  });

  it("sorts even when input is unsorted, and handles empty input", () => {
    expect(groupByMissing([row(1, 3), row(2, 0)]).map((g) => g.missing)).toEqual([0, 3]);
    expect(groupByMissing([])).toEqual([]);
  });
});

describe("missingGroupTitle / missingLine", () => {
  it("names the counts in Russian", () => {
    expect(missingGroupTitle(0)).toBe("Всё есть");
    expect(missingGroupTitle(3)).toBe("Не хватает трёх");
    expect(missingGroupTitle(5)).toBe("Не хватает пяти");
    expect(missingGroupTitle(7)).toBe("Не хватает 7");
  });
  it("formats the guest line", () => {
    expect(missingLine([])).toBe("");
    expect(missingLine([{ key: "lime", name: "Лайм" }, { key: "mint", name: "Мята" }])).toBe("нет: лайм, мята");
  });
});

describe("categories", () => {
  it("has a Russian label for every category in the order", () => {
    for (const c of CATEGORY_ORDER) expect(CATEGORY_LABEL[c]).toMatch(/[а-яё]/i);
    expect(new Set(CATEGORY_ORDER).size).toBe(Object.keys(CATEGORY_LABEL).length);
  });

  it("falls back to «Прочее» for unknown categories", () => {
    expect(categoryLabel("spirits")).toBe("Крепкий алкоголь");
    expect(categoryLabel("space-food")).toBe("Прочее");
  });

  it("groups by category order with names sorted alphabetically", () => {
    const groups = groupByCategory([
      { name: "Чеснок", category: "vegetables" },
      { name: "Джин", category: "spirits" },
      { name: "Лук", category: "vegetables" },
      { name: "Космос", category: "unknown" },
      { name: "Абсент", category: "spirits" },
      { name: "Ёрш", category: "other" },
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Крепкий алкоголь", "Овощи", "Прочее"]);
    expect(groups[0]!.items.map((i) => i.name)).toEqual(["Абсент", "Джин"]);
    expect(groups[1]!.items.map((i) => i.name)).toEqual(["Лук", "Чеснок"]);
    expect(groups[2]!.items.map((i) => i.name)).toEqual(["Ёрш", "Космос"]);
  });
});

describe("quick sets", () => {
  it("returns only the names not yet in the pantry (ru or en, ё-insensitive)", () => {
    const bar = QUICK_SETS.find((s) => s.id === "bar")!;
    const pantry = [
      { name: "Лайм", nameEn: "lime" },
      { name: "Содовая", nameEn: "soda water" },
      { name: "Angostura", nameEn: "angostura bitters" },
    ];
    expect(missingFromSet({ ...bar, names: [...bar.names, "angostura bitters"] }, pantry)).toEqual([
      "лимон",
      "сахарный сироп",
      "тоник",
      "апельсин",
      "мята",
      "ангостура",
    ]);
    const kitchen = QUICK_SETS.find((s) => s.id === "kitchen")!;
    expect(missingFromSet(kitchen, [{ name: "Черный перец", nameEn: "black pepper" }])).not.toContain("чёрный перец");
  });
});

describe("misc", () => {
  it("pluralises the product counter", () => {
    expect(productCount(1)).toBe("1 продукт");
    expect(productCount(34)).toBe("34 продукта");
    expect(productCount(11)).toBe("11 продуктов");
  });

  it("builds the inline confirmation", () => {
    expect(addedMessage(["Лайм", "Мята"], [])).toBe("Добавлено: лайм, мята");
    expect(addedMessage([], ["Лайм"])).toBe("Уже есть: лайм");
    expect(addedMessage(["Мята"], ["Лайм"])).toBe("Добавлено: мята · уже было: лайм");
    expect(addedMessage(["a", "b", "c", "d", "e", "f", "g", "h"], [])).toBe("Добавлено: a, b, c, d, e, f и ещё 2");
  });

  it("pre-highlights a suggestion only when it continues the typed text", () => {
    expect(suggestionMatches("лай", { name: "Лайм", nameEn: "lime" })).toBe(true);
    expect(suggestionMatches("lim", { name: "Лайм", nameEn: "lime" })).toBe(true);
    expect(suggestionMatches("копчёная паприка", { name: "Паприка", nameEn: "paprika" })).toBe(false);
    expect(suggestionMatches(" ", { name: "Лайм", nameEn: "lime" })).toBe(false);
  });
});
