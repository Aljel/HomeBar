import { describe, expect, it } from "vitest";
import { isConvertibleVolume, isLiquidUnit, normalizeUnit, toMl } from "./units";

describe("units", () => {
  it("normalises aliases, case, plurals and dots", () => {
    expect(normalizeUnit("Dashes")).toBe("dash");
    expect(normalizeUnit("oz.")).toBe("oz");
    expect(normalizeUnit(" TSP ")).toBe("tsp");
    expect(normalizeUnit("bar spoon")).toBe("barspoon");
    expect(normalizeUnit("мл")).toBe("ml");
    expect(normalizeUnit("pcs")).toBe("pcs");
  });

  it("converts liquid units to ml", () => {
    expect(toMl(1, "oz")).toBe(30);
    expect(toMl(2, "cl")).toBe(20);
    expect(toMl(1, "tsp")).toBe(5);
    expect(toMl(1, "tbsp")).toBe(15);
    expect(toMl(3, "dashes")).toBe(3);
    expect(toMl(1, "barspoon")).toBe(5);
    expect(toMl(1, "shot")).toBe(45);
    expect(toMl(45, "ml")).toBe(45);
  });

  it("returns null for non-liquid or missing amounts", () => {
    expect(toMl(null, "ml")).toBeNull();
    expect(toMl(2, "pcs")).toBeNull();
    expect(toMl(10, "g")).toBeNull();
    expect(toMl(0, "ml")).toBeNull();
    expect(isLiquidUnit("")).toBe(false);
  });

  it("only converts real volume units in the ml/oz toggle", () => {
    expect(isConvertibleVolume("cl")).toBe(true);
    expect(isConvertibleVolume("oz")).toBe(true);
    expect(isConvertibleVolume("tsp")).toBe(false);
    expect(isConvertibleVolume("dash")).toBe(false);
  });
});
