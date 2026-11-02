import { getToken, setToken } from "../lib/auth";
import { toastError } from "../lib/toast";
import type {
  Availability,
  AvailableFilters,
  CatalogIngredient,
  DiscoverKind,
  LibrarySource,
  LibrarySyncStatus,
  Paged,
  PantryItem,
  PantrySuggestion,
  Settings,
  Ingredient,
  LocalRecipe,
  Menu,
  MenuSummary,
  Order,
  OrderStatus,
  Page,
  Recipe,
  RecipeFilters,
  RecipeInput,
  RecipeSummary,
  RecipeVersion,
  RecipeVersionSummary,
  Source,
  Stats,
  TagCount,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function isApiError(e: unknown, status?: number): e is ApiError {
  return e instanceof ApiError && (status === undefined || e.status === status);
}

/** Human-readable message for any thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof TypeError) return "Нет связи с баром — проверьте сеть.";
  if (e instanceof Error) return e.message;
  return "Что-то пошло не так.";
}

const STATUS_FALLBACK: Record<number, string> = {
  400: "Проверьте введённые данные.",
  401: "Нужен ключ хозяина.",
  404: "Не найдено.",
  500: "Ошибка на стороне бара — попробуйте ещё раз.",
  502: "Внешний источник не ответил.",
  503: "Сейчас недоступно (офлайн-режим).",
};

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOptions {
  query?: Query;
  body?: unknown;
  form?: FormData;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

let unauthorizedNotified = 0;

async function send(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(buildUrl(`/api${path}`, opts.query), { method, headers, body, signal: opts.signal });

  if (!res.ok) {
    const fallback = STATUS_FALLBACK[res.status];
    let message = fallback ?? `Ошибка ${res.status}`;
    // the backend's messages are English/technical ("recipe 7 not found"): prefer our Russian
    // text when we have one, but keep the server's validation details for 400s
    if (fallback === undefined || res.status === 400) {
      try {
        const data = (await res.json()) as { error?: unknown };
        if (typeof data.error === "string" && data.error) message = data.error;
      } catch {
        /* non-JSON error body */
      }
    }
    // only drop the token this request was sent with (not one obtained by a newer login)
    if (res.status === 401 && token && getToken() === token) {
      setToken(null);
      // avoid a toast storm when several requests fail at once
      if (Date.now() - unauthorizedNotified > 3000) {
        unauthorizedNotified = Date.now();
        toastError("Ключ хозяина больше не подходит — войдите снова.");
      }
    }
    throw new ApiError(res.status, message);
  }
  return res;
}

async function parseBody<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  return parseBody<T>(await send(method, path, opts));
}

/** GET of a list that reports its full size in `X-Total-Count` (falls back to "this page is all"). */
async function requestPaged<T>(path: string, opts: RequestOptions & { offset?: number } = {}): Promise<Paged<T>> {
  const res = await send("GET", path, opts);
  const items = (await parseBody<T[]>(res)) ?? [];
  const header = Number(res.headers.get("X-Total-Count"));
  const total = Number.isFinite(header) && res.headers.has("X-Total-Count") ? header : (opts.offset ?? 0) + items.length;
  return { items, total };
}

const enc = encodeURIComponent;

export const api = {
  // auth
  login: (password: string) => request<{ token: string }>("POST", "/auth/login", { body: { password } }),
  me: () => request<{ admin: boolean }>("GET", "/auth/me"),

  // meta
  stats: (signal?: AbortSignal) => request<Stats>("GET", "/stats", { signal }),
  tags: (signal?: AbortSignal) => request<TagCount[]>("GET", "/tags", { signal }),

  // recipes
  recipes: (f: RecipeFilters, signal?: AbortSignal) =>
    request<RecipeSummary[]>("GET", "/recipes", {
      query: { q: f.q, kind: f.kind, favorite: f.favorite, source: f.source, tag: f.tag },
      signal,
    }),
  /** paged variant (`limit`/`offset` + `X-Total-Count`) for long lists */
  recipesPage: (f: RecipeFilters, limit: number, offset: number, signal?: AbortSignal) =>
    requestPaged<RecipeSummary>("/recipes", {
      query: { q: f.q, kind: f.kind, favorite: f.favorite, source: f.source, tag: f.tag, limit, offset },
      offset,
      signal,
    }),
  recipe: (id: number, signal?: AbortSignal) => request<LocalRecipe>("GET", `/recipes/${id}`, { signal }),
  createRecipe: (input: RecipeInput) => request<LocalRecipe>("POST", "/recipes", { body: input }),
  updateRecipe: (id: number, input: RecipeInput) => request<LocalRecipe>("PUT", `/recipes/${id}`, { body: input }),
  deleteRecipe: (id: number) => request<void>("DELETE", `/recipes/${id}`),
  setFavorite: (id: number, favorite: boolean) =>
    request<LocalRecipe>("PUT", `/recipes/${id}/favorite`, { body: { favorite } }),
  forkRecipe: (id: number, title?: string) =>
    request<LocalRecipe>("POST", `/recipes/${id}/fork`, { body: title ? { title } : {} }),
  versions: (id: number, signal?: AbortSignal) =>
    request<RecipeVersionSummary[]>("GET", `/recipes/${id}/versions`, { signal }),
  version: (id: number, vid: number, signal?: AbortSignal) =>
    request<RecipeVersion>("GET", `/recipes/${id}/versions/${vid}`, { signal }),
  restoreVersion: (id: number, vid: number) =>
    request<LocalRecipe>("POST", `/recipes/${id}/versions/${vid}/restore`),

  // discover
  discoverRandom: (kind: DiscoverKind, count: number, signal?: AbortSignal) =>
    request<Recipe[]>("GET", "/discover/random", { query: { kind, count }, signal }),
  discoverSearch: (q: string, kind: DiscoverKind, signal?: AbortSignal) =>
    request<Recipe[]>("GET", "/discover/search", { query: { q, kind }, signal }),
  discoverLookup: (source: Source, sourceId: string, signal?: AbortSignal) =>
    request<Recipe>("GET", "/discover/lookup", { query: { source, sourceId }, signal }),
  discoverImport: (source: Source, sourceId: string) =>
    request<LocalRecipe>("POST", "/discover/import", { body: { source, sourceId } }),

  // menus
  menus: (signal?: AbortSignal) => request<MenuSummary[]>("GET", "/menus", { signal }),
  activeMenu: (signal?: AbortSignal) => request<Menu>("GET", "/menus/active", { signal }),
  menu: (id: number, signal?: AbortSignal) => request<Menu>("GET", `/menus/${id}`, { signal }),
  createMenu: (title: string, description: string) =>
    request<Menu>("POST", "/menus", { body: { title, description } }),
  updateMenu: (id: number, title: string, description: string) =>
    request<Menu>("PUT", `/menus/${id}`, { body: { title, description } }),
  deleteMenu: (id: number) => request<void>("DELETE", `/menus/${id}`),
  setMenuItems: (id: number, items: { recipeId: number; note?: string }[]) =>
    request<Menu>("PUT", `/menus/${id}/items`, { body: { items } }),
  activateMenu: (id: number) => request<Menu>("POST", `/menus/${id}/activate`),
  deactivateMenu: (id: number) => request<Menu>("POST", `/menus/${id}/deactivate`),

  // orders
  createOrder: (input: { recipeId: number; menuId?: number; guestName: string; note?: string }) =>
    request<Order>("POST", "/orders", { body: input }),
  order: (id: number, signal?: AbortSignal) => request<Order>("GET", `/orders/${id}`, { signal }),
  orders: (status: "active" | "all", signal?: AbortSignal) =>
    request<Order[]>("GET", "/orders", { query: { status }, signal }),
  setOrderStatus: (id: number, status: OrderStatus) =>
    request<Order>("PATCH", `/orders/${id}`, { body: { status } }),
  orderStreamUrl: () => buildUrl("/api/orders/stream", { token: getToken() }),

  // pages
  page: (slug: string, signal?: AbortSignal) => request<Page>("GET", `/pages/${enc(slug)}`, { signal }),
  savePage: (slug: string, title: string, body: string) =>
    request<Page>("PUT", `/pages/${enc(slug)}`, { body: { title, body } }),

  // ingredients & pantry (v2)
  ingredients: (q: string, limit = 20, signal?: AbortSignal) =>
    request<CatalogIngredient[]>("GET", "/ingredients", { query: { q, limit }, signal }),
  pantry: (signal?: AbortSignal) => request<PantryItem[]>("GET", "/pantry", { signal }),
  addToPantry: (names: string[]) => request<PantryItem[]>("POST", "/pantry", { body: { names } }),
  removeFromPantry: (key: string) => request<void>("DELETE", `/pantry/${enc(key)}`),
  clearPantry: () => request<void>("DELETE", "/pantry"),
  pantrySuggestions: (kind: DiscoverKind | undefined, limit = 12, signal?: AbortSignal) =>
    request<PantrySuggestion[]>("GET", "/pantry/suggestions", { query: { kind, limit }, signal }),
  available: (f: AvailableFilters, limit: number, offset: number, signal?: AbortSignal) =>
    requestPaged<Availability>("/available", {
      // maxMissing 0 is meaningful: send it explicitly (buildUrl drops only undefined/""/false)
      query: { kind: f.kind, maxMissing: f.maxMissing ?? 0, q: f.q, tag: f.tag, limit, offset },
      offset,
      signal,
    }),
  settings: (signal?: AbortSignal) => request<Settings>("GET", "/settings", { signal }),
  saveSettings: (s: Settings) => request<Settings>("PUT", "/settings", { body: s }),

  // bulk library (v2)
  librarySyncStatus: (signal?: AbortSignal) => request<LibrarySyncStatus>("GET", "/library/sync", { signal }),
  startLibrarySync: (sources: LibrarySource[]) => request<LibrarySyncStatus>("POST", "/library/sync", { body: { sources } }),

  // uploads
  upload: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ url: string }>("POST", "/uploads", { form });
  },
};

export function emptyIngredient(): Ingredient {
  return { name: "", amount: null, unit: "ml", note: "" };
}
