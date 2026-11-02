import { describe, expect, it } from "vitest";
import { feedPlan, feedSegments, interleave, parseFeedFilter, uniqueBy } from "./feed";

describe("interleave", () => {
  it("adds an idea after every 4 own items and appends the rest", () => {
    const own = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const out = interleave(own, ["a", "b", "c", "d"], 4);
    expect(out.map((e) => e.item)).toEqual([1, 2, 3, 4, "a", 5, 6, 7, 8, "b", 9, "c", "d"]);
    expect(out.filter((e) => e.type === "idea")).toHaveLength(4);
  });
  it("works with no ideas or no own items", () => {
    expect(interleave([1, 2], [], 4).map((e) => e.type)).toEqual(["own", "own"]);
    expect(interleave([], ["a", "b"], 4).map((e) => e.type)).toEqual(["idea", "idea"]);
  });
  it("does not end on an idea placed right after the last own item when ideas run out", () => {
    const out = interleave([1, 2, 3, 4], ["a"], 4);
    expect(out.map((e) => e.item)).toEqual([1, 2, 3, 4, "a"]);
  });
});

describe("uniqueBy", () => {
  it("keeps first occurrences", () => {
    expect(uniqueBy([{ id: "1" }, { id: "2" }, { id: "1" }], (x) => x.id)).toEqual([{ id: "1" }, { id: "2" }]);
  });
});

describe("feed filters", () => {
  it("parses unknown values as all", () => {
    expect(parseFeedFilter("dishes")).toBe("dishes");
    expect(parseFeedFilter("nope")).toBe("all");
    expect(parseFeedFilter(null)).toBe("all");
  });
  it("plans queries per filter", () => {
    expect(feedPlan("all")).toEqual({ own: {}, ideas: "cocktail" });
    expect(feedPlan("dishes")).toEqual({ own: { kind: "dish" }, ideas: "dish" });
    expect(feedPlan("favorites").ideas).toBeNull();
    expect(feedPlan("ideas").own).toBeNull();
  });
});

describe("feedSegments", () => {
  it("puts favourites, then own, then imported for broad filters", () => {
    expect(feedSegments(feedPlan("all").own)).toEqual([{ favorite: true }, { source: "own" }, { source: "imported" }]);
    expect(feedSegments(feedPlan("cocktails").own)).toEqual([
      { kind: "cocktail", favorite: true },
      { kind: "cocktail", source: "own" },
      { kind: "cocktail", source: "imported" },
    ]);
  });
  it("uses a single segment for narrow filters and none for ideas/makeable", () => {
    expect(feedSegments(feedPlan("favorites").own)).toEqual([{ favorite: true }]);
    expect(feedSegments(feedPlan("mine").own)).toEqual([{ source: "own" }]);
    expect(feedSegments(feedPlan("ideas").own)).toEqual([]);
    expect(feedPlan("makeable")).toEqual({ own: null, ideas: null, makeable: true });
    expect(parseFeedFilter("makeable")).toBe("makeable");
  });
});
