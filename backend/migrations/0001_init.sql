-- HomeBar initial schema. Timestamps are RFC3339 UTC strings with fixed
-- millisecond precision so that lexical order equals chronological order.

CREATE TABLE recipes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT    NOT NULL,
    kind         TEXT    NOT NULL CHECK (kind IN ('cocktail', 'dish', 'other')),
    description  TEXT    NOT NULL DEFAULT '',
    instructions TEXT    NOT NULL DEFAULT '',
    image_url    TEXT,
    servings     REAL    NOT NULL DEFAULT 1,
    glass        TEXT,
    garnish      TEXT,
    method       TEXT,
    favorite     INTEGER NOT NULL DEFAULT 0,
    source       TEXT    NOT NULL DEFAULT 'own' CHECK (source IN ('own', 'thecocktaildb', 'themealdb')),
    source_id    TEXT,
    source_url   TEXT,
    parent_id    INTEGER REFERENCES recipes (id) ON DELETE SET NULL,
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL
);

CREATE UNIQUE INDEX ux_recipes_external ON recipes (source, source_id)
    WHERE source <> 'own' AND source_id IS NOT NULL;
CREATE INDEX ix_recipes_parent ON recipes (parent_id);

CREATE TABLE recipe_ingredients (
    recipe_id INTEGER NOT NULL REFERENCES recipes (id) ON DELETE CASCADE,
    position  INTEGER NOT NULL,
    name      TEXT    NOT NULL,
    amount    REAL,
    unit      TEXT    NOT NULL DEFAULT '',
    note      TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (recipe_id, position)
);

CREATE TABLE recipe_tags (
    recipe_id INTEGER NOT NULL REFERENCES recipes (id) ON DELETE CASCADE,
    position  INTEGER NOT NULL,
    tag       TEXT    NOT NULL,
    PRIMARY KEY (recipe_id, tag)
);
CREATE INDEX ix_recipe_tags_tag ON recipe_tags (tag);

CREATE TABLE recipe_versions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id  INTEGER NOT NULL REFERENCES recipes (id) ON DELETE CASCADE,
    note       TEXT    NOT NULL DEFAULT '',
    title      TEXT    NOT NULL,
    snapshot   TEXT    NOT NULL,
    created_at TEXT    NOT NULL
);
CREATE INDEX ix_recipe_versions_recipe ON recipe_versions (recipe_id, id);

CREATE TABLE menus (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    is_active   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);
-- At most one active menu, enforced by the database as a last line of defence.
CREATE UNIQUE INDEX ux_menus_single_active ON menus (is_active) WHERE is_active = 1;

CREATE TABLE menu_items (
    menu_id   INTEGER NOT NULL REFERENCES menus (id) ON DELETE CASCADE,
    recipe_id INTEGER NOT NULL REFERENCES recipes (id) ON DELETE CASCADE,
    position  INTEGER NOT NULL,
    note      TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (menu_id, recipe_id)
);
CREATE INDEX ix_menu_items_recipe ON menu_items (recipe_id);

-- recipe_id deliberately has no foreign key: orders outlive deleted recipes
-- and keep recipe_title.
CREATE TABLE orders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_id      INTEGER REFERENCES menus (id) ON DELETE SET NULL,
    recipe_id    INTEGER NOT NULL,
    recipe_title TEXT    NOT NULL,
    guest_name   TEXT    NOT NULL,
    note         TEXT    NOT NULL DEFAULT '',
    status       TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'making', 'done', 'cancelled')),
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL
);
CREATE INDEX ix_orders_status ON orders (status, id);
CREATE INDEX ix_orders_created ON orders (created_at);

CREATE TABLE pages (
    slug       TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);
