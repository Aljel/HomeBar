# HomeBar API contract

Single source of truth shared by backend (Rust/axum, `backend/`) and frontend (React/Vite, `frontend/`).

- All endpoints are under `/api`. JSON bodies, **camelCase** field names.
- Timestamps: RFC3339 strings (UTC).
- Errors: non-2xx with body `{ "error": "human readable message" }`.
  400 validation, 401 missing/invalid admin token, 404 not found, 502 external source failed.
- Uploaded files are served at `/uploads/<file>`; everything else not under `/api` or `/uploads`
  is the SPA (static files, falling back to `index.html`).

## Auth (host / admin)

There is one host password (env `ADMIN_PASSWORD`, default `homebar`, a warning is logged when default).
Guests never log in: they can read everything, and create orders.

- `POST /api/auth/login` `{ "password": string }` → `200 { "token": string }` or 401.
  Token = hex(HMAC-SHA256(key = ADMIN_PASSWORD, msg = "homebar-admin-v1")) — deterministic, survives restarts.
- `GET /api/auth/me` → `{ "admin": boolean }` (checks the bearer token if present, never 401).
- Admin-only endpoints (marked 🔒) require `Authorization: Bearer <token>`.
  The SSE endpoint additionally accepts `?token=<token>` (EventSource cannot set headers).
  Compare in constant time.

## Types

```ts
type Kind = "cocktail" | "dish" | "other";
type Source = "own" | "thecocktaildb" | "themealdb";

interface Ingredient {
  name: string;          // "Gin"
  amount: number | null; // 45  (null for "to taste", "top up", etc.)
  unit: string;          // "ml" | "oz" | "cl" | "dash" | "tsp" | "tbsp" | "g" | "pcs" | "" ...
  note: string;          // "freshly squeezed", or the raw unparsed measure for imports
}

interface Recipe {
  id: number | null;            // null for not-yet-imported discover results
  title: string;
  kind: Kind;
  description: string;          // short, plain text
  instructions: string;         // markdown
  imageUrl: string | null;      // absolute external URL or "/uploads/..."
  servings: number;             // base yield the amounts are written for (>= 1, may be fractional)
  glass: string | null;
  garnish: string | null;
  method: string | null;        // "shake" | "stir" | "build" | "blend" | free text
  tags: string[];               // lower-case, trimmed, deduplicated
  favorite: boolean;
  source: Source;
  sourceId: string | null;      // external id (e.g. idDrink)
  sourceUrl: string | null;
  parentId: number | null;      // set when the recipe is a fork/variation of another recipe
  importedId: number | null;    // discover results only: id of local copy if already imported, else null. Always null for local recipes.
  ingredients: Ingredient[];    // ordered
  createdAt: string | null;     // null for discover results
  updatedAt: string | null;
}

interface RecipeSummary {
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

// Body for create / update
interface RecipeInput {
  title: string;                // 1..200 chars, required
  kind: Kind;
  description?: string;         // <= 2000
  instructions?: string;        // <= 20000
  imageUrl?: string | null;
  servings?: number;            // default 1, must be > 0 and <= 1000
  glass?: string | null;
  garnish?: string | null;
  method?: string | null;
  tags?: string[];              // <= 30 tags, each <= 40 chars
  favorite?: boolean;
  ingredients?: Ingredient[];   // <= 60
  versionNote?: string;         // update only: note stored with the snapshot of the PREVIOUS state
}

interface RecipeVersionSummary { id: number; recipeId: number; note: string; title: string; createdAt: string; }
interface RecipeVersion extends RecipeVersionSummary { recipe: Recipe; }   // recipe = snapshot

interface MenuSummary { id: number; title: string; description: string; isActive: boolean; itemCount: number; createdAt: string; updatedAt: string; }
interface MenuItem { recipeId: number; position: number; note: string; recipe: RecipeSummary; }
interface Menu extends MenuSummary { items: MenuItem[]; }

type OrderStatus = "new" | "making" | "done" | "cancelled";
interface Order {
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

interface Page { slug: string; title: string; body: string /* markdown */; updatedAt: string; }
interface TagCount { tag: string; count: number; }
interface Stats { recipes: number; cocktails: number; dishes: number; favorites: number; own: number; imported: number; ordersToday: number; }
```

## Endpoints

### Health / meta
- `GET /api/health` → `{ "ok": true, "version": string }`
- `GET /api/stats` → `Stats`
- `GET /api/tags` → `TagCount[]` sorted by count desc, then tag asc.

### Recipes
- `GET /api/recipes?q=&kind=&favorite=true&source=own|imported&tag=` → `RecipeSummary[]`
  - `q` matches title, description, ingredient names (case-insensitive substring).
  - `source=imported` means any source other than `own`.
  - sorted: favorites first, then `updatedAt` desc.
- `GET /api/recipes/:id` → `Recipe`
- 🔒 `POST /api/recipes` `RecipeInput` → `201 Recipe` (source = "own")
- 🔒 `PUT /api/recipes/:id` `RecipeInput` → `Recipe`. Before applying, the previous state is snapshotted
  into versions (with `versionNote`, default ""). Source/sourceId/sourceUrl/parentId are preserved.
- 🔒 `DELETE /api/recipes/:id` → `204`. (Removes from menus too; orders keep `recipeTitle`.)
- 🔒 `PUT /api/recipes/:id/favorite` `{ "favorite": boolean }` → `Recipe` (no version snapshot)
- 🔒 `POST /api/recipes/:id/fork` `{ "title"?: string }` → `201 Recipe` — copy as a new own recipe,
  `parentId` = original id, `source` = "own", title defaults to `"<title> (вариация)"`.
- `GET /api/recipes/:id/versions` → `RecipeVersionSummary[]` newest first
- `GET /api/recipes/:id/versions/:vid` → `RecipeVersion`
- 🔒 `POST /api/recipes/:id/versions/:vid/restore` → `Recipe` (current state is snapshotted first, note "before restore")

### Discover (external sources, "Попробуйте")
Sources: TheCocktailDB (`https://www.thecocktaildb.com/api/json/v1/1/`) for cocktails,
TheMealDB (`https://www.themealdb.com/api/json/v1/1/`) for dishes. Results are not saved.
- `GET /api/discover/random?kind=cocktail|dish&count=6` → `Recipe[]` (count 1..12, default 6;
  deduplicated by sourceId; `id` null, `importedId` filled if already in the DB).
  Partial upstream failures are tolerated (return what succeeded); all failed → 502.
- `GET /api/discover/search?q=margarita&kind=cocktail|dish` → `Recipe[]` (max 24)
- `GET /api/discover/lookup?source=thecocktaildb&sourceId=11007` → `Recipe`
- 🔒 `POST /api/discover/import` `{ "source": Source, "sourceId": string }` → `201 Recipe`
  (or `200 Recipe` with the existing local recipe if already imported).

Import mapping: measures like `"1 1/2 oz"`, `"2 cl"`, `"1/2"`, `"3-4 dashes"`, `"Juice of 1"` are parsed into
amount/unit when possible (fractions, mixed numbers; ranges like "3-4" → lower bound), otherwise amount null
and the raw measure goes to `note`. Tags = upstream tags + category + alcoholic flag (lower-cased).
Kind: thecocktaildb → cocktail, themealdb → dish. Upstream images are hot-linked (`imageUrl`).

### Menus (what guests can pick from)
- `GET /api/menus` → `MenuSummary[]`
- `GET /api/menus/active` → `Menu` or 404 if no active menu
- `GET /api/menus/:id` → `Menu`
- 🔒 `POST /api/menus` `{ title, description? }` → `201 Menu`
- 🔒 `PUT /api/menus/:id` `{ title, description? }` → `Menu`
- 🔒 `DELETE /api/menus/:id` → `204`
- 🔒 `PUT /api/menus/:id/items` `{ "items": [{ "recipeId": number, "note"?: string }] }` → `Menu`
  (replaces the whole list; order of array = position)
- 🔒 `POST /api/menus/:id/activate` → `Menu` (exactly one active menu; others deactivated)
- 🔒 `POST /api/menus/:id/deactivate` → `Menu`

### Orders (guests pick from the menu)
- `POST /api/orders` `{ "recipeId": number, "menuId"?: number, "guestName": string (1..60), "note"?: string (<=300) }`
  → `201 Order`. If menuId given the recipe must be in that menu (400 otherwise).
- `GET /api/orders/:id` → `Order` (public, so the guest can watch status)
- 🔒 `GET /api/orders?status=active|all` → `Order[]` (active = new + making; default active), oldest first for active, newest first for all
- 🔒 `PATCH /api/orders/:id` `{ "status": OrderStatus }` → `Order`
- 🔒 `GET /api/orders/stream` (SSE, `?token=` allowed) — events `event: order`, `data: <Order JSON>`
  sent on every create/update; keep-alive comments every 15s.

### Pages (editable text: landing, about, ...)
- `GET /api/pages` → `Page[]`
- `GET /api/pages/:slug` → `Page` (404 if missing). Seeded slugs: `home`, `about`.
- 🔒 `PUT /api/pages/:slug` `{ title, body }` → `Page` (upsert; slug `[a-z0-9-]{1,40}`)

### Uploads
- 🔒 `POST /api/uploads` multipart, field `file`, image/jpeg|png|webp|gif|avif, ≤ 8 MB
  → `201 { "url": "/uploads/<uuid>.<ext>" }`. Content type is sniffed from magic bytes, not trusted from client.

## Runtime config (env)
| var | default | |
|---|---|---|
| `PORT` | `8080` | |
| `DATA_DIR` | `./data` | SQLite db `homebar.db` + `uploads/` |
| `STATIC_DIR` | `./static` | built frontend; if missing, only API is served |
| `ADMIN_PASSWORD` | `homebar` | |
| `RUST_LOG` | `info` | |
| `EXTERNAL_TIMEOUT_SECS` | `8` | |
| `DISCOVER_ENABLED` | `true` | if false, discover endpoints return 503 (offline mode) |

---

# v2 additions: pantry (кладовая), availability, bulk library

Goal: the host keeps a list of products they have at home. Guests are offered only what can be prepared from it
(dishes and cocktails), ranked by how many ingredients are missing (0 first). The host alone edits the pantry —
nothing is ever added/removed automatically (no auto-decrement after orders).

## Ingredient identity
Recipe ingredient names are free text in two languages ("Сок лайма", "Lime juice", "lime"). Each name resolves to
a canonical **ingredient key** (lower-case English, e.g. `lime juice`, `light rum`, `egg`):
1. normalise: trim, lower-case, `ё→е`, collapse spaces, strip trailing punctuation/brackets;
2. look up in the ingredient catalog by `nameEn`, `nameRu` or any alias (all normalised);
3. not found → key = the normalised name itself (custom ingredient; matching still works for exact names).

The catalog is seeded from an embedded JSON (`backend/data/ingredients.json`): the most common bar & kitchen
ingredients (≥ 400, covering everything frequent in TheCocktailDB/TheMealDB) with Russian names, aliases
(RU + EN synonyms, e.g. "белый ром", "светлый ром", "rum, light"), category and an optional `parent` key
(`light rum` → `rum`, `lime juice` → none, `cherry tomatoes` → `tomato`).
**Matching rule:** pantry key P satisfies recipe key R if `P == R`, or `parent(R) == P` (have generic "rum", recipe
wants "light rum" → ok), or `parent(P) == R` (have "light rum", recipe wants "rum" → ok).
**Staples** never count as missing: `water`, `ice`, `hot water`, `cold water`, `boiling water` (flag `staple: true` in catalog).

Resolved keys are stored per recipe ingredient (column) on every write, and backfilled on startup when the catalog
version changes.

`Ingredient` in all recipe responses gains a read-only field `key: string` (ignored in input).

## Types
```ts
type IngredientCategory = "spirits" | "liqueurs" | "wine" | "beer" | "mixers" | "juices" | "syrups" | "bitters"
  | "fruits" | "vegetables" | "herbs" | "spices" | "dairy" | "eggs" | "meat" | "fish" | "grains" | "bakery"
  | "sauces" | "oils" | "sweets" | "nuts" | "other";

interface CatalogIngredient {
  key: string;
  name: string;          // Russian name if known, else English
  nameEn: string;
  category: IngredientCategory;
  inPantry: boolean;     // satisfied by pantry (incl. parent/child rule)
  recipeCount: number;   // how many local recipes use it
}
interface PantryItem { key: string; name: string; nameEn: string; category: IngredientCategory; addedAt: string; }
interface Availability {
  recipe: RecipeSummary;
  total: number;                       // non-staple ingredients
  missing: { key: string; name: string }[];   // empty = can be made now
}
interface PantrySuggestion { key: string; name: string; category: IngredientCategory; unlocks: number; } // recipes that become fully makeable by adding just this
interface Settings { guestMaxMissing: number; /* 0..3, default 0 */ guestShowMenu: boolean; /* show curated active menu on /menu, default true */ }
interface LibrarySyncStatus {
  running: boolean;
  source: Source | null;
  done: number; total: number;          // progress of current run
  imported: number; skipped: number; failed: number;
  startedAt: string | null; finishedAt: string | null;
  lastError: string | null;
}
```

## Endpoints
- `GET /api/ingredients?q=&limit=20` → `CatalogIngredient[]` — autocomplete. Matches prefix/substring of RU name,
  EN name and aliases; ranking: exact > prefix > substring, then recipeCount desc. Empty `q` → most used.
  Also includes custom keys used by local recipes.
- `GET /api/pantry` → `PantryItem[]` sorted by category, name (public read).
- 🔒 `POST /api/pantry` `{ "names": string[] }` (1..100 names, each 1..80 chars) → `PantryItem[]` (full list).
  Each name is resolved to a key (unknown → custom key; its display name = the typed text). Duplicates ignored.
- 🔒 `DELETE /api/pantry/:key` (url-encoded key) → `204`.
- 🔒 `DELETE /api/pantry` → `204` (clear all; UI asks for confirmation).
- `GET /api/pantry/suggestions?kind=&limit=12` → `PantrySuggestion[]` (unlocks desc, only unlocks ≥ 1).
- `GET /api/available?kind=cocktail|dish&maxMissing=0..5&q=&tag=&limit=60&offset=0` → `Availability[]`
  sorted: missing count asc, favorites first, own before imported, title asc. Default maxMissing=0.
  Header `X-Total-Count` with the total number of matches.
- `GET /api/settings` → `Settings`; 🔒 `PUT /api/settings` `Settings` → `Settings`.
- `GET /api/menus/active` and `GET /api/menus/:id`: each `MenuItem` gains `missing: { key, name }[]`
  (computed from pantry) so the guest page can hide/mark unavailable curated items.
- `POST /api/orders` unchanged (menuId optional — orders from the pantry-based list send no menuId).

### Bulk library (massive recipe base)
- 🔒 `POST /api/library/sync` `{ "sources": ("thecocktaildb" | "themealdb")[] }` → `202 LibrarySyncStatus`
  (409 if already running). Background job:
  - TheMealDB: `search.php?f=<a..z>` (returns full meals, ~800 total).
  - TheCocktailDB (free key caps list endpoints at 100): collect ids from `filter.php?c=<each category>`,
    `filter.php?a=Alcoholic|Non_Alcoholic`, `filter.php?g=<each glass>` (from `list.php?g=list`) and
    `filter.php?i=<each ingredient>` (from `list.php?i=list` + the catalog's top spirits/mixers), dedupe,
    then `lookup.php?i=<id>` for ids not yet imported (~600 total).
  - Concurrency ≤ 4, small delay between requests, retries with backoff on 429/5xx, skip already imported
    (source, sourceId). Imported recipes: `favorite=false`, same mapping as `/api/discover/import`.
- `GET /api/library/sync` → `LibrarySyncStatus` (public).
- `GET /api/recipes` gains optional `limit` (1..200) & `offset` + `X-Total-Count` header; without `limit` it
  returns everything as before (keep backward compatible).
