import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../../api/client";
import { keys, useVersion, useVersions } from "../../api/queries";
import { useIsHost } from "../../lib/auth";
import { formatDateTime } from "../../lib/format";
import { useUnitSystem } from "../../lib/prefs";
import { toastError, toastSuccess } from "../../lib/toast";
import { Dialog } from "../Dialog";
import { Button } from "../Button";
import { Markdown } from "../Markdown";
import { EmptyState, ErrorState, Skeleton } from "../States";
import { IngredientList } from "./IngredientList";
import "./versions.css";

export function VersionsDrawer({ recipeId, open, onClose }: { recipeId: number; open: boolean; onClose: () => void }) {
  const list = useVersions(recipeId, open);
  const [selected, setSelected] = useState<number | null>(null);
  const version = useVersion(recipeId, selected);
  const isHost = useIsHost();
  const qc = useQueryClient();
  const [system] = useUnitSystem();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setSelected(null);
    setConfirming(false);
    onClose();
  };

  async function restore() {
    if (selected === null) return;
    setBusy(true);
    try {
      const r = await api.restoreVersion(recipeId, selected);
      qc.setQueryData(keys.recipe(recipeId), r);
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.versions(recipeId) }),
        qc.invalidateQueries({ queryKey: keys.recipesAll }),
        qc.invalidateQueries({ queryKey: keys.tags }),
        qc.invalidateQueries({ queryKey: keys.menus }),
        qc.invalidateQueries({ queryKey: keys.availableAll }),
      ]);
      toastSuccess("Версия восстановлена. Прежнее состояние сохранено в истории.");
      close();
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={close} title={selected === null ? "История изменений" : "Прежняя версия"} variant="drawer">
      {selected === null ? (
        list.isPending ? (
          <div className="stack" aria-busy="true">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} h={58} />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : list.data.length === 0 ? (
          <EmptyState title="Пока без правок">Каждое сохранение рецепта откладывает сюда прежний вариант.</EmptyState>
        ) : (
          <ol className="versions">
            {list.data.map((v, i) => (
              <li key={v.id}>
                <button type="button" className="versions__item" onClick={() => setSelected(v.id)}>
                  <span className="versions__main">
                    <span className="versions__title">{v.title}</span>
                    <span className="versions__note">{v.note || (i === 0 ? "предыдущее состояние" : "без заметки")}</span>
                  </span>
                  <time className="versions__time" dateTime={v.createdAt}>
                    {formatDateTime(v.createdAt)}
                  </time>
                </button>
              </li>
            ))}
          </ol>
        )
      ) : (
        <div className="stack">
          <Button variant="quiet" icon="arrowLeft" className="versions__back" onClick={() => setSelected(null)}>
            Все версии
          </Button>
          {version.isPending ? (
            <div className="stack" aria-busy="true">
              <Skeleton h={30} w="70%" />
              <Skeleton h={120} />
            </div>
          ) : version.isError ? (
            <ErrorState error={version.error} onRetry={() => version.refetch()} />
          ) : (
            <article className="snapshot">
              <p className="muted small">
                Версия от {formatDateTime(version.data.createdAt)}
                {version.data.note && ` · «${version.data.note}»`}
              </p>
              <h3 className="snapshot__title">{version.data.recipe.title}</h3>
              {version.data.recipe.description && <p>{version.data.recipe.description}</p>}
              <IngredientList ingredients={version.data.recipe.ingredients} factor={1} system={system} />
              {version.data.recipe.instructions && (
                <div className="snapshot__md">
                  <Markdown source={version.data.recipe.instructions} />
                </div>
              )}
              {isHost &&
                (confirming ? (
                  <div className="snapshot__confirm" role="group" aria-label="Подтверждение">
                    <p>Вернуть рецепт к этой версии? Текущее состояние тоже сохранится в истории.</p>
                    <div className="row">
                      <Button variant="primary" icon="history" onClick={restore} disabled={busy}>
                        {busy ? "Восстанавливаю…" : "Да, восстановить"}
                      </Button>
                      <Button onClick={() => setConfirming(false)}>Отмена</Button>
                    </div>
                  </div>
                ) : (
                  <Button icon="history" onClick={() => setConfirming(true)}>
                    Восстановить эту версию
                  </Button>
                ))}
            </article>
          )}
        </div>
      )}
    </Dialog>
  );
}
