import { createStore, useStore } from "./store";
import { readString, writeString } from "./storage";

const KEY = "token";
const STORAGE_KEY = `homebar:${KEY}`;

export const tokenStore = createStore<string | null>(readString(KEY));

// keep tabs in sync: logging out (or in) in one tab applies to all of them
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === null || e.key === STORAGE_KEY) tokenStore.set(readString(KEY));
  });
}

export function setToken(token: string | null): void {
  writeString(KEY, token);
  tokenStore.set(token);
}

export function getToken(): string | null {
  return tokenStore.get();
}

/** True when a host token is present (validated against /api/auth/me on startup). */
export function useIsHost(): boolean {
  return useStore(tokenStore) !== null;
}
