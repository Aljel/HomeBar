import { describe, expect, it } from "vitest";
import { formatFraction, formatMeasure, formatOz, measureText, parseAmount, roundMl, scaleFactor, toFraction } from "./measure";

describe("scaling", () => {
  it("computes factor from base servings", () => {
    expect(scaleFactor(1, 3)).toBe(3);
    expect(scaleFactor(2, 3)).toBe(1.5);
    expect(scaleFactor(0, 3)).toBe(1);
  });
});

describe("rounding", () => {
  it("rounds ml to bar-friendly steps", () => {
    expect(roundMl(22.5)).toBe(22.5);
    expect(roundMl(7.3)).toBe(7.5);
    expect(roundMl(44)).toBe(45);
    expect(roundMl(133)).toBe(135);
    expect(roundMl(0.1)).toBe(0.5);
  });

  it("finds kitchen fractions", () => {
    expect(toFraction(0.75, [2, 4])).toEqual({ whole: 0, num: 3, den: 4 });
    expect(toFraction(1.5, [2, 4])).toEqual({ whole: 1, num: 1, den: 2 });
    expect(toFraction(0.33, [2, 3, 4])).toEqual({ whole: 0, num: 1, den: 3 });
    expect(toFraction(1.97, [2, 4])).toEqual({ whole: 2, num: 0, den: 1 });
  });

  it("formats fractions with glyphs", () => {
    expect(formatFraction(0.75)).toBe("¾");
    expect(formatFraction(1.5)).toBe("1\u2009½");
    expect(formatFraction(2)).toBe("2");
    expect(formatOz(0.125)).toBe("⅛");
    expect(formatOz(0.8)).toBe("¾");
    expect(formatOz(0.01)).toBe("⅛");
  });
});

describe("formatMeasure", () => {
  const gin = { amount: 45, unit: "ml" };
  it("keeps ml in ml mode and converts to oz", () => {
    expect(formatMeasure(gin, 1, "ml")).toEqual({ qty: "45", unit: "мл" });
    expect(formatMeasure(gin, 1, "oz")).toEqual({ qty: "1\u2009½", unit: "oz" });
  });
  it("converts oz and cl to ml with decimal comma", () => {
    expect(formatMeasure({ amount: 0.75, unit: "oz" }, 1, "ml")).toEqual({ qty: "22,5", unit: "мл" });
    expect(formatMeasure({ amount: 2, unit: "cl" }, 1, "ml")).toEqual({ qty: "20", unit: "мл" });
  });
  it("scales amounts", () => {
    expect(formatMeasure({ amount: 0.75, unit: "oz" }, 2, "oz")).toEqual({ qty: "1\u2009½", unit: "oz" });
    expect(formatMeasure({ amount: 30, unit: "ml" }, 3, "ml")).toEqual({ qty: "90", unit: "мл" });
    expect(formatMeasure({ amount: 1, unit: "tsp" }, 1.5, "ml")).toEqual({ qty: "1\u2009½", unit: "ч. л." });
  });
  it("leaves spoons and dashes in their own units", () => {
    expect(formatMeasure({ amount: 2, unit: "dashes" }, 1, "oz")).toEqual({ qty: "2", unit: "дэш" });
  });
  it("handles null amounts and grams", () => {
    expect(formatMeasure({ amount: null, unit: "" }, 2, "ml")).toEqual({ qty: "", unit: "" });
    expect(formatMeasure({ amount: 250, unit: "g" }, 1.5, "ml")).toEqual({ qty: "375", unit: "г" });
    expect(formatMeasure({ amount: 2.5, unit: "g" }, 1, "ml")).toEqual({ qty: "2,5", unit: "г" });
  });
  it("joins into text with nbsp", () => {
    expect(measureText({ qty: "45", unit: "мл" })).toBe("45\u00a0мл");
    expect(measureText({ qty: "2", unit: "" })).toBe("2");
  });
});

describe("parseAmount", () => {
  it("parses decimals, fractions and glyphs", () => {
    expect(parseAmount("45")).toBe(45);
    expect(parseAmount("0,75")).toBe(0.75);
    expect(parseAmount("1/2")).toBe(0.5);
    expect(parseAmount("1 1/2")).toBe(1.5);
    expect(parseAmount("1½")).toBe(1.5);
    expect(parseAmount("¾")).toBe(0.75);
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("abc")).toBeNaN();
  });
});
