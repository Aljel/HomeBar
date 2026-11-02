import { describe, expect, it } from "vitest";
import type { Ingredient } from "../api/types";
import { stockOf } from "./stock";

const ing = (name: string, key?: string): Ingredient => ({ name, amount: null, unit: "", note: "", key });

describe("stockOf", () => {
  it("marks each row by the server's missing list, staples never missing", () => {
    const ings = [ing("Белый ром", "light rum"), ing("Сок лайма", "lime juice"), ing("Лёд", "ice"), ing("Содовая", "soda water")];
    const s = stockOf(ings, [{ key: "lime juice", name: "Сок лайма" }]);
    expect(s.marks).toEqual(["have", "missing", "staple", "have"]);
    expect(s.missing).toEqual([{ key: "lime juice", name: "Сок лайма" }]);
  });

  it("dedupes missing keys, drops staples, keeps unknown rows unmarked", () => {
    const ings = [ing("Лайм", "lime"), ing("Лайм (долька)", "lime"), ing("Вода", "water"), ing("Что-то")];
    const s = stockOf(ings, [
      { key: "lime", name: "Лайм" },
      { key: "lime", name: "Лайм" },
      { key: "water", name: "Вода" },
    ]);
    expect(s.marks).toEqual(["missing", "missing", "staple", null]);
    expect(s.missing).toEqual([{ key: "lime", name: "Лайм" }]);
  });
});
