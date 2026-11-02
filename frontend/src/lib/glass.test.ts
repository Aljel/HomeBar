import { describe, expect, it } from "vitest";
import { TINTS, glassFromName, guessGlass, tintFor } from "./glass";

describe("glassFromName", () => {
  it("maps Russian and English glass names", () => {
    expect(glassFromName("Рокс")).toBe("rocks");
    expect(glassFromName("Old-fashioned glass")).toBe("rocks");
    expect(glassFromName("Купе")).toBe("coupe");
    expect(glassFromName("Margarita glass")).toBe("coupe");
    expect(glassFromName("Cocktail glass")).toBe("martini");
    expect(glassFromName("Хайбол")).toBe("highball");
    expect(glassFromName("Collins Glass")).toBe("highball");
    expect(glassFromName("Бокал для вина")).toBe("wine");
    expect(glassFromName("Champagne flute")).toBe("wine");
    expect(glassFromName("Coffee mug")).toBe("mug");
    expect(glassFromName("Irish coffee cup")).toBe("mug");
    expect(glassFromName("Shot glass")).toBe("shot");
  });
  it("returns null for empty or unknown names", () => {
    expect(glassFromName(null)).toBeNull();
    expect(glassFromName("  ")).toBeNull();
    expect(glassFromName("ведро")).toBeNull();
  });
});

describe("guessGlass", () => {
  it("prefers the explicit glass", () => {
    expect(guessGlass({ kind: "cocktail", glass: "Хайбол", title: "Дайкири" })).toBe("highball");
  });
  it("guesses drinks from title and ingredients", () => {
    expect(guessGlass({ kind: "cocktail", title: "Апероль шприц" })).toBe("wine");
    expect(guessGlass({ kind: "cocktail", title: "Мохито", ingredientNames: ["Ром", "Мята", "Содовая"] })).toBe("highball");
    expect(guessGlass({ kind: "cocktail", title: "Джин-тоник" })).toBe("highball");
    expect(guessGlass({ kind: "cocktail", title: "Дайкири" })).toBe("coupe");
    expect(guessGlass({ kind: "cocktail", title: "Dry Martini" })).toBe("martini");
    expect(guessGlass({ kind: "cocktail", title: "Негрони", ingredientNames: ["Джин", "Кампари"] })).toBe("rocks");
  });
  it("uses plates and bowls for dishes", () => {
    expect(guessGlass({ kind: "dish", title: "Гуакамоле" })).toBe("bowl");
    expect(guessGlass({ kind: "dish", title: "Томатный суп" })).toBe("bowl");
    expect(guessGlass({ kind: "dish", title: "Шакшука" })).toBe("bowl");
    expect(guessGlass({ kind: "dish", title: "Брускетта" })).toBe("plate");
    expect(guessGlass({ kind: "other", title: "Что-то" })).toBe("mug");
  });
});

describe("tintFor", () => {
  it("is deterministic and from the palette", () => {
    expect(tintFor(7)).toEqual(tintFor("7"));
    expect(TINTS).toContainEqual(tintFor("negroni"));
  });
});
