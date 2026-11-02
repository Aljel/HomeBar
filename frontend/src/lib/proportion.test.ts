import { describe, expect, it } from "vitest";
import { computeProportions, formatShare, stackLayers } from "./proportion";

const negroni = [
  { name: "Gin", amount: 30, unit: "ml" },
  { name: "Campari", amount: 1, unit: "oz" },
  { name: "Vermouth", amount: 3, unit: "cl" },
  { name: "Orange peel", amount: 1, unit: "pcs" },
];

describe("computeProportions", () => {
  it("shares liquid volume in ml across units", () => {
    const p = computeProportions(negroni);
    expect(p.totalMl).toBe(90);
    expect(p.parts.map((l) => l.share)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(p.undrawn).toEqual([3]);
  });
  it("keeps true shares for tiny amounts", () => {
    const p = computeProportions([
      { name: "Whiskey", amount: 60, unit: "ml" },
      { name: "Bitters", amount: 1, unit: "dash" },
    ]);
    expect(p.parts[1]?.share).toBeCloseTo(1 / 61);
  });
  it("draws nothing when no amounts are liquid", () => {
    const p = computeProportions([{ name: "Mint", amount: null, unit: "" }, { name: "Sugar", amount: 2, unit: "g" }]);
    expect(p.parts).toEqual([]);
    expect(p.undrawn).toEqual([0, 1]);
  });
  it("formats shares", () => {
    expect(formatShare(0.333)).toBe("33%");
    expect(formatShare(0.004)).toBe("<1%");
  });
});

describe("stackLayers", () => {
  it("stacks bottom-up with heights proportional to share", () => {
    const { parts } = computeProportions(negroni);
    const layers = stackLayers(parts, 0, 90);
    expect(layers.map((l) => l.h)).toEqual([30, 30, 30]);
    expect(layers[0]!.y).toBe(60); // first ingredient sits at the bottom
    expect(layers[2]!.y).toBeCloseTo(0);
  });
  it("gives tiny parts a minimum height and still fills exactly", () => {
    const { parts } = computeProportions([
      { name: "Whiskey", amount: 60, unit: "ml" },
      { name: "Syrup", amount: 7.5, unit: "ml" },
      { name: "Bitters", amount: 2, unit: "dash" },
    ]);
    const layers = stackLayers(parts, 10, 110, 4);
    expect(layers[2]!.h).toBe(4);
    const sum = layers.reduce((s, l) => s + l.h, 0);
    expect(sum).toBeCloseTo(100);
    expect(layers.at(-1)!.y).toBeCloseTo(10);
    expect(layers[0]!.h).toBeGreaterThan(layers[1]!.h);
  });
  it("returns nothing for an empty list", () => {
    expect(stackLayers([], 0, 100)).toEqual([]);
  });
});
