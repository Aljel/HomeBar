import { createStore, useStore } from "./store";
import { readJson, writeJson } from "./storage";

export interface MyOrderRef {
  id: number;
  /** ms epoch when placed */
  at: number;
  /** ms epoch when first seen done/cancelled */
  finishedAt?: number;
}

const KEY = "myOrders";
/** finished orders stay visible this long, then quietly disappear */
export const FINISHED_TTL_MS = 20 * 60_000;
const MAX_AGE_MS = 24 * 60 * 60_000;

function isRefs(v: unknown): v is MyOrderRef[] {
  return Array.isArray(v) && v.every((x) => typeof x === "object" && x !== null && typeof (x as MyOrderRef).id === "number");
}

function prune(list: MyOrderRef[], now = Date.now()): MyOrderRef[] {
  return list.filter((o) => now - o.at < MAX_AGE_MS && (o.finishedAt === undefined || now - o.finishedAt < FINISHED_TTL_MS));
}

const store = createStore<MyOrderRef[]>(prune(readJson(KEY, isRefs, [])));
store.subscribe(() => writeJson(KEY, store.get()));

export function addMyOrder(id: number): void {
  store.set((l) => [...l.filter((o) => o.id !== id), { id, at: Date.now() }]);
}
export function markFinished(id: number): void {
  store.set((l) => (l.some((o) => o.id === id && o.finishedAt === undefined) ? l.map((o) => (o.id === id ? { ...o, finishedAt: Date.now() } : o)) : l));
}
export function forgetOrder(id: number): void {
  store.set((l) => l.filter((o) => o.id !== id));
}
export function pruneMyOrders(): void {
  store.set((l) => {
    const p = prune(l);
    return p.length === l.length ? l : p;
  });
}
export function useMyOrders(): MyOrderRef[] {
  return useStore(store);
}
