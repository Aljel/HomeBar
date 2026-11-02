import { useDeferredValue, useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../../api/client";
import { flattenRecipePages, keys, useMenu, useMenus, usePagedRecipes } from "../../api/queries";
import type { Menu, RecipeSummary } from "../../api/types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Button, IconButton } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { Img } from "../../components/Img";
import { EmptyState, ErrorState, Skeleton } from "../../components/States";
import { formatDate } from "../../lib/format";
import { guessGlass } from "../../lib/glass";
import { toastError, toastSuccess } from "../../lib/toast";
import "./menu-manager.css";

interface DraftItem {
  recipeId: number;
  note: string;
  recipe: RecipeSummary;
}

function RecipePicker({ exclude, onAdd }: { exclude: Set<number>; onAdd: (r: RecipeSummary) => void }) {
  const [q, setQ] = useState("");
  const deferred = useDeferredValue(q.trim());
  // one page is plenty for a picker (the base can hold ~1400 recipes): search narrows it
  const segments = useMemo(() => [{ q: deferred || undefined }], [deferred]);
  const recipes = usePagedRecipes(segments, 60);
  const list = flattenRecipePages(recipes.data).filter((r) => !exclude.has(r.id)).slice(0, 30);
  return (
    <div className="picker">
      <label className="field">
        <span>Добавить рецепт</span>
        <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по рецептам" />
      </label>
      {recipes.isPending ? (
        <Skeleton h={120} />
      ) : recipes.isError ? (
        <ErrorState error={recipes.error} onRetry={() => recipes.refetch()} />
      ) : list.length === 0 ? (
        <p className="muted">{deferred ? "Ничего не нашлось." : "Все рецепты уже в меню."}</p>
      ) : (
        <ul className="picker__list">
          {list.map((r) => (
            <li key={r.id}>
              <button type="button" className="picker__item" onClick={() => onAdd(r)}>
                <span className="picker__img">
                  <Img src={r.imageUrl} alt="" thumb glass={guessGlass({ kind: r.kind, title: r.title, ingredientNames: r.ingredientNames })} seed={r.id} ratio="1 / 1" width={80} height={80} />
                </span>
                <span className="picker__title">{r.title}</span>
                <Icon name="plus" />
                <span className="visually-hidden">добавить в меню</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MenuEditor({ menu, onDeleted }: { menu: Menu; onDeleted: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(menu.title);
  const [description, setDescription] = useState(menu.description);
  const [items, setItems] = useState<DraftItem[]>(() => menu.items.map((it) => ({ recipeId: it.recipeId, note: it.note, recipe: it.recipe })));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const sync = (m: Menu) => {
    qc.setQueryData(keys.menu(m.id), m);
    qc.invalidateQueries({ queryKey: keys.menus });
  };
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const edit = (next: DraftItem[]) => {
    setItems(next);
    setDirty(true);
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j]!, next[i]!];
    edit(next);
  };

  const saveInfo = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      toastError("У меню должно быть название.");
      return;
    }
    void run("info", async () => {
      const m = await api.updateMenu(menu.id, title.trim(), description.trim());
      sync(m);
      toastSuccess("Название и описание сохранены.");
    });
  };
  const saveItems = () =>
    run("items", async () => {
      const m = await api.setMenuItems(
        menu.id,
        items.map((it) => ({ recipeId: it.recipeId, note: it.note.trim() || undefined })),
      );
      sync(m);
      setDirty(false);
      toastSuccess("Состав меню сохранён.");
    });
  const toggleActive = () =>
    run("active", async () => {
      const m = menu.isActive ? await api.deactivateMenu(menu.id) : await api.activateMenu(menu.id);
      sync(m);
      qc.invalidateQueries({ queryKey: keys.activeMenu });
      // activating one menu deactivates others
      qc.invalidateQueries({ queryKey: ["menus"] });
      toastSuccess(m.isActive ? "Меню показано гостям." : "Меню скрыто от гостей.");
    });
  const remove = () =>
    run("delete", async () => {
      await api.deleteMenu(menu.id);
      await qc.invalidateQueries({ queryKey: keys.menus, exact: true });
      qc.removeQueries({ queryKey: keys.menu(menu.id) });
      qc.invalidateQueries({ queryKey: keys.activeMenu });
      toastSuccess("Меню удалено.");
      setConfirmDelete(false);
      onDeleted();
    });

  const included = new Set(items.map((i) => i.recipeId));

  return (
    <div className="menu-editor panel">
      <form className="menu-editor__info" onSubmit={saveInfo}>
        <div className="menu-editor__status">
          <span className={`pill ${menu.isActive ? "pill--live" : "pill--off"}`}>{menu.isActive ? "Видно гостям" : "Скрыто"}</span>
          <span className="muted small">обновлено {formatDate(menu.updatedAt)}</span>
        </div>
        <label className="field">
          <span>Название</span>
          <input className="input input--title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </label>
        <label className="field">
          <span>Описание для гостей</span>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
        </label>
        <div className="row">
          <Button type="submit" disabled={busy === "info" || (title === menu.title && description === menu.description)}>
            Сохранить описание
          </Button>
          <span className="spacer" />
          <Button icon={menu.isActive ? "close" : "check"} onClick={toggleActive} disabled={busy === "active"}>
            {menu.isActive ? "Скрыть от гостей" : "Показать гостям"}
          </Button>
          <IconButton icon="trash" label="Удалить меню" look="plain" tone="danger" onClick={() => setConfirmDelete(true)} />
        </div>
      </form>

      <section className="menu-editor__items" aria-labelledby="mi-title">
        <div className="row menu-editor__items-head">
          <h3 id="mi-title">
            Позиции <span className="queue__count">{items.length}</span>
          </h3>
          <span className="spacer" />
          {dirty && <span className="menu-editor__dirty">Есть несохранённые изменения</span>}
          <Button variant="primary" icon="check" onClick={saveItems} disabled={!dirty || busy === "items"}>
            {busy === "items" ? "Сохраняю…" : "Сохранить состав"}
          </Button>
        </div>
        {items.length === 0 ? (
          <p className="muted small">Добавьте рецепты из списка ниже.</p>
        ) : (
          <ol className="mitems">
            {items.map((it, i) => (
              <li key={it.recipeId} className="mitem">
                <span className="mitem__n">{i + 1}</span>
                <div className="mitem__main">
                  <span className="mitem__title">{it.recipe.title}</span>
                  <label className="field">
                    <span className="visually-hidden">Заметка для «{it.recipe.title}»</span>
                    <input
                      className="input mitem__note"
                      value={it.note}
                      onChange={(e) => edit(items.map((x) => (x.recipeId === it.recipeId ? { ...x, note: e.target.value } : x)))}
                      placeholder="Заметка для гостей (необязательно)"
                    />
                  </label>
                </div>
                <div className="mitem__tools">
                  <IconButton icon="up" label={`Выше: ${it.recipe.title}`} look="plain" onClick={() => move(i, -1)} disabled={i === 0} />
                  <IconButton icon="down" label={`Ниже: ${it.recipe.title}`} look="plain" onClick={() => move(i, 1)} disabled={i === items.length - 1} />
                  <IconButton
                    icon="close"
                    label={`Убрать из меню: ${it.recipe.title}`}
                    look="plain"
                    tone="danger"
                    onClick={() => edit(items.filter((x) => x.recipeId !== it.recipeId))}
                  />
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <RecipePicker exclude={included} onAdd={(r) => edit([...items, { recipeId: r.id, note: "", recipe: r }])} />

      <ConfirmDialog
        open={confirmDelete}
        title="Удалить меню?"
        confirmLabel="Удалить"
        danger
        busy={busy === "delete"}
        onConfirm={remove}
        onClose={() => setConfirmDelete(false)}
      >
        <p>«{menu.title}» пропадёт. Рецепты останутся, заказы — в истории.</p>
      </ConfirmDialog>
    </div>
  );
}

export function MenuManager() {
  const menus = useMenus();
  const [selected, setSelected] = useState<number | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();
  const current = selected ?? menus.data?.find((m) => m.isActive)?.id ?? menus.data?.[0]?.id ?? null;
  const menu = useMenu(current);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      const m = await api.createMenu(newTitle.trim(), "");
      qc.setQueryData(keys.menu(m.id), m);
      await qc.invalidateQueries({ queryKey: keys.menus });
      setSelected(m.id);
      setNewTitle("");
      toastSuccess(`Меню «${m.title}» создано.`);
    } catch (err) {
      toastError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="mm">
      <aside className="mm__list" aria-label="Все меню">
        {menus.isPending ? (
          <div className="stack" aria-busy="true">
            <Skeleton h={52} />
            <Skeleton h={52} />
          </div>
        ) : menus.isError ? (
          <ErrorState error={menus.error} onRetry={() => menus.refetch()} />
        ) : (
          <ul className="mm__menus">
            {menus.data.map((m) => (
              <li key={m.id}>
                <button type="button" className="mm__menu" aria-current={m.id === current ? "true" : undefined} onClick={() => setSelected(m.id)}>
                  <span className="mm__menu-title">{m.title}</span>
                  <span className="mm__menu-meta">
                    {m.itemCount} поз.{m.isActive && " · видно гостям"}
                  </span>
                  {m.isActive && <span className="mm__live" aria-hidden="true" />}
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="mm__create inline-form" onSubmit={create}>
          <label className="field">
            <span>Новое меню</span>
            <input className="input" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Например, «Осенний вечер»" maxLength={200} />
          </label>
          <Button type="submit" icon="plus" disabled={!newTitle.trim() || creating}>
            Создать
          </Button>
        </form>
      </aside>

      <div className="mm__editor">
        {current === null ? (
          menus.isSuccess && <EmptyState title="Меню ещё нет">Создайте первое меню — гости увидят его в разделе «Меню».</EmptyState>
        ) : menu.isPending ? (
          <Skeleton h={360} r={16} />
        ) : menu.isError ? (
          <ErrorState error={menu.error} onRetry={() => menu.refetch()} />
        ) : (
          <MenuEditor key={menu.data.id} menu={menu.data} onDeleted={() => setSelected(null)} />
        )}
      </div>
    </div>
  );
}
