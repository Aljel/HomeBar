import { describe, expect, it } from "vitest";
import type { Order } from "../api/types";
import { upsertActive } from "./useOrderStream";

const o = (id: number, status: Order["status"], createdAt: string): Order => ({
  id, status, createdAt, updatedAt: createdAt, menuId: 1, recipeId: 1, recipeTitle: "X", guestName: "G", note: "",
});

describe("upsertActive", () => {
  it("adds, updates in place, keeps oldest first and drops finished orders", () => {
    let list = upsertActive(undefined, o(2, "new", "2026-10-31T20:05:00Z"));
    list = upsertActive(list, o(1, "new", "2026-10-31T20:00:00Z"));
    expect(list.map((x) => x.id)).toEqual([1, 2]);
    list = upsertActive(list, o(1, "making", "2026-10-31T20:00:00Z"));
    expect(list[0]?.status).toBe("making");
    list = upsertActive(list, o(2, "done", "2026-10-31T20:05:00Z"));
    expect(list.map((x) => x.id)).toEqual([1]);
  });
});
