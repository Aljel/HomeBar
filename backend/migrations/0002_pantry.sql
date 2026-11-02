-- v2: ingredient identity, pantry, guest settings, bulk library.

-- Canonical ingredient key (see catalog.rs), resolved on every write and
-- backfilled on startup whenever the embedded catalog changes.
ALTER TABLE recipe_ingredients ADD COLUMN ingredient_key TEXT NOT NULL DEFAULT '';
CREATE INDEX ix_recipe_ingredients_key ON recipe_ingredients (ingredient_key);

-- What the host has at home. `name` is the text the host typed (display name
-- for custom keys, and the input for re-resolution when the catalog changes).
CREATE TABLE pantry (
    key      TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    added_at TEXT NOT NULL
);

-- Single-row guest settings.
CREATE TABLE settings (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    guest_max_missing INTEGER NOT NULL DEFAULT 0 CHECK (guest_max_missing BETWEEN 0 AND 3),
    guest_show_menu   INTEGER NOT NULL DEFAULT 1
);
INSERT INTO settings (id, guest_max_missing, guest_show_menu) VALUES (1, 0, 1);

-- Internal key/value bookkeeping (e.g. the catalog hash used for backfills).
CREATE TABLE app_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Monotonic change counter for everything a recipe summary is built from;
-- lets the server cache the library index safely (see pantry.rs).
CREATE TABLE recipe_data_version (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
);
INSERT INTO recipe_data_version (id, version) VALUES (1, 0);

CREATE TRIGGER trg_recipes_ins AFTER INSERT ON recipes
BEGIN UPDATE recipe_data_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER trg_recipes_upd AFTER UPDATE ON recipes
BEGIN UPDATE recipe_data_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER trg_recipes_del AFTER DELETE ON recipes
BEGIN UPDATE recipe_data_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER trg_recipe_ingredients_ins AFTER INSERT ON recipe_ingredients
BEGIN UPDATE recipe_data_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER trg_recipe_ingredients_upd AFTER UPDATE ON recipe_ingredients
BEGIN UPDATE recipe_data_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER trg_recipe_ingredients_del AFTER DELETE ON recipe_ingredients
BEGIN UPDATE recipe_data_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER trg_recipe_tags_ins AFTER INSERT ON recipe_tags
BEGIN UPDATE recipe_data_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER trg_recipe_tags_del AFTER DELETE ON recipe_tags
BEGIN UPDATE recipe_data_version SET version = version + 1 WHERE id = 1; END;
