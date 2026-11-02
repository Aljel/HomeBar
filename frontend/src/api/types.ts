// Mirrors docs/API.md exactly.

export type Kind = "cocktail" | "dish" | "other";
export type Source = "own" | "thecocktaildb" | "themealdb";

export interface Ingredient {
  name: string;
  amount: number | null;
  unit: string;
  note: string;
  /** v2, read-only: canonical ingredient key resolved by the backend (ignored in input) */
  key?: string;
}

export interface Recipe {
  id: number | null;
  title: string;
  kind: Kind;
  description: string;
  instructions: string;
  imageUrl: string | null;
  servings: number;
  glass: string | null;
  garnish: string | null;
  method: string | null;
  tags: string[];
  favorite: boolean;
  source: Source;
  sourceId: string | null;
  sourceUrl: string | null;
  parentId: number | null;
  importedId: number | null;
  ingredients: Ingredient[];
  createdAt: string | null;
  updatedAt: string | null;
}

/** A recipe stored locally always has an id. */
export type LocalRecipe = Recipe & { id: number };

export interface RecipeSummary {
  id: number;
  title: string;
  kind: Kind;
  description: string;
  imageUrl: string | null;
  tags: string[];
  favorite: boolean;
  source: Source;
  parentId: number | null;
  ingredientNames: string[];
  updatedAt: string;
}

export interface RecipeInput {
  title: string;
  kind: Kind;
  description?: string;
  instructions?: string;
  imageUrl?: string | null;
  servings?: number;
  glass?: string | null;
  garnish?: string | null;
  method?: string | null;
  tags?: string[];
  favorite?: boolean;
  ingredients?: Ingredient[];
  versionNote?: string;
}

export interface RecipeVersionSummary {
  id: number;
  recipeId: number;
  note: string;
  title: string;
  createdAt: string;
}

export interface RecipeVersion extends RecipeVersionSummary {
  recipe: Recipe;
}

export interface MenuSummary {
  id: number;
  title: string;
  description: string;
  isActive: boolean;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MenuItem {
  recipeId: number;
  position: number;
  note: string;
  recipe: RecipeSummary;
  /** v2: ingredients not covered by the pantry (absent on older backends = treat as available) */
  missing?: MissingIngredient[];
}

export interface Menu extends MenuSummary {
  items: MenuItem[];
}

export type OrderStatus = "new" | "making" | "done" | "cancelled";

export interface Order {
  id: number;
  menuId: number | null;
  recipeId: number;
  recipeTitle: string;
  guestName: string;
  note: string;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Page {
  slug: string;
  title: string;
  body: string;
  updatedAt: string;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface Stats {
  recipes: number;
  cocktails: number;
  dishes: number;
  favorites: number;
  own: number;
  imported: number;
  ordersToday: number;
}

export interface RecipeFilters {
  q?: string;
  kind?: Kind;
  favorite?: boolean;
  source?: "own" | "imported";
  tag?: string;
}

export type DiscoverKind = "cocktail" | "dish";

// ---------- v2: pantry, availability, library ----------

export type IngredientCategory =
  | "spirits"
  | "liqueurs"
  | "wine"
  | "beer"
  | "mixers"
  | "juices"
  | "syrups"
  | "bitters"
  | "fruits"
  | "vegetables"
  | "herbs"
  | "spices"
  | "dairy"
  | "eggs"
  | "meat"
  | "fish"
  | "grains"
  | "bakery"
  | "sauces"
  | "oils"
  | "sweets"
  | "nuts"
  | "other";

export interface MissingIngredient {
  key: string;
  name: string;
}

export interface CatalogIngredient {
  key: string;
  name: string;
  nameEn: string;
  category: IngredientCategory;
  inPantry: boolean;
  recipeCount: number;
}

export interface PantryItem {
  key: string;
  name: string;
  nameEn: string;
  category: IngredientCategory;
  addedAt: string;
}

export interface Availability {
  recipe: RecipeSummary;
  total: number;
  missing: MissingIngredient[];
}

export interface PantrySuggestion {
  key: string;
  name: string;
  category: IngredientCategory;
  unlocks: number;
}

export interface Settings {
  guestMaxMissing: number;
  guestShowMenu: boolean;
}

export type LibrarySource = "thecocktaildb" | "themealdb";

export interface LibrarySyncStatus {
  running: boolean;
  source: Source | null;
  done: number;
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

export interface AvailableFilters {
  kind?: DiscoverKind;
  maxMissing?: number;
  q?: string;
  tag?: string;
}

/** A page of a list endpoint that reports `X-Total-Count`. */
export interface Paged<T> {
  items: T[];
  total: number;
}
