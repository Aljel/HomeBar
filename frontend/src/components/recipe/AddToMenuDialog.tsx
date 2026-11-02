import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../../api/client";
import { keys, useMenus } from "../../api/queries";
import { toast, toastError, toastSuccess } from "../../lib/toast";
import { Dialog } from "../Dialog";
import { Button } from "../Button";
import { Icon } from "../Icon";
import { ErrorState, Skeleton } from "../States";

export function AddToMenuDialog({ recipeId, open, onClose }: { recipeId: number; open: boolean; onClose: () => void }) {
  const menus = useMenus(open);
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [newTitle, setNewTitle] = useState("");

  async function addTo(menuId: number) {
    setBusyId(menuId);
    try {
      const menu = await api.menu(menuId);
      if (menu.items.some((it) => it.recipeId === recipeId)) {
        toast(`Уже есть в меню «${menu.title}».`);
        onClose();
        return;
      }
      const items = [...menu.items.map((it) => ({ recipeId: it.recipeId, note: it.note })), { recipeId }];
      const updated = await api.setMenuItems(menuId, items);
      qc.setQueryData(keys.menu(menuId), updated);
      await qc.invalidateQueries({ queryKey: keys.menus });
      toastSuccess(`Добавлено в меню «${updated.title}».`);
      onClose();
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  }

  async function createAndAdd(e: FormEvent) {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    setBusyId(-1);
    try {
      const m = await api.createMenu(title, "");
      setNewTitle("");
      // the new menu exists even if adding the recipe below fails
      void qc.invalidateQueries({ queryKey: keys.menus });
      await addTo(m.id);
    } catch (err) {
      toastError(errorMessage(err));
      setBusyId(null);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Добавить в меню">
      <div className="stack">
        {menus.isPending ? (
          <div className="stack" aria-busy="true">
            <Skeleton h={48} />
            <Skeleton h={48} />
          </div>
        ) : menus.isError ? (
          <ErrorState error={menus.error} onRetry={() => menus.refetch()} />
        ) : menus.data.length === 0 ? (
          <p className="muted">Меню ещё нет — создайте первое.</p>
        ) : (
          <ul className="pick-list">
            {menus.data.map((m) => (
              <li key={m.id}>
                <button type="button" className="pick-list__item" onClick={() => addTo(m.id)} disabled={busyId !== null}>
                  <span className="pick-list__main">
                    <span className="pick-list__title">{m.title}</span>
                    {m.isActive && <span className="pick-list__live">сейчас у гостей</span>}
                  </span>
                  <span className="pick-list__meta">{busyId === m.id ? "добавляю…" : `${m.itemCount} поз.`}</span>
                  <Icon name="plus" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="inline-form" onSubmit={createAndAdd}>
          <label className="field">
            <span>Новое меню</span>
            <input className="input" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Например, «Пятница»" maxLength={200} />
          </label>
          <Button type="submit" icon="plus" disabled={!newTitle.trim() || busyId !== null}>
            Создать и добавить
          </Button>
        </form>
      </div>
    </Dialog>
  );
}
