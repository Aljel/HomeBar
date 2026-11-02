import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, isApiError } from "../../api/client";
import { invalidateRecipeLists, keys, useLibrarySync, useStats } from "../../api/queries";
import type { LibrarySyncStatus } from "../../api/types";
import { Button } from "../../components/Button";
import { formatDateTime } from "../../lib/format";
import { recipeCount } from "../../lib/pantry";
import { toastError, toastSuccess } from "../../lib/toast";

const SOURCE_NAME: Record<string, string> = { thecocktaildb: "TheCocktailDB", themealdb: "TheMealDB", own: "свои" };

function Progress({ s }: { s: LibrarySyncStatus }) {
  const pct = s.total > 0 ? Math.min(100, Math.round((s.done / s.total) * 100)) : null;
  return (
    <div className="lib__progress">
      <div
        className={`lib__bar ${pct === null ? "lib__bar--indeterminate" : ""}`}
        role="progressbar"
        aria-label="Загрузка базы рецептов"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
      >
        <span style={{ width: pct === null ? undefined : `${pct}%` }} />
      </div>
      <p className="lib__line" aria-live="polite">
        {s.source ? `${SOURCE_NAME[s.source] ?? s.source}: ` : ""}
        {s.total > 0 ? `${s.done} из ${s.total}` : "собираю список…"}
        {s.imported > 0 && ` · добавлено ${s.imported}`}
      </p>
    </div>
  );
}

/** «Библиотека рецептов»: bulk import from TheCocktailDB + TheMealDB with live progress. */
export function LibraryCard() {
  const qc = useQueryClient();
  const status = useLibrarySync();
  const stats = useStats();
  const [starting, setStarting] = useState(false);
  const s = status.data;
  const running = !!s?.running;

  // a run just finished: the catalogue, counters and availability changed
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running && s) {
      invalidateRecipeLists(qc);
      if (s.lastError && s.imported === 0) toastError(`Загрузка базы не удалась: ${s.lastError}`);
      else toastSuccess(`База рецептов загружена: добавлено ${s.imported}.`);
    }
    wasRunning.current = running;
  }, [running, s, qc]);

  async function start() {
    setStarting(true);
    try {
      const next = await api.startLibrarySync(["thecocktaildb", "themealdb"]);
      qc.setQueryData(keys.librarySync, next);
    } catch (e) {
      if (isApiError(e, 409)) qc.invalidateQueries({ queryKey: keys.librarySync });
      else toastError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  }

  const unavailable = status.isError && isApiError(status.error, 404);

  return (
    <section className="pcard lib" aria-labelledby="lib-title">
      <h2 id="lib-title" className="pcard__title">
        Библиотека рецептов
      </h2>
      <p className="muted small">
        {stats.data ? `Сейчас в базе ${recipeCount(stats.data.recipes)}. ` : ""}
        Можно загрузить около 1400 коктейлей и блюд — тогда «что приготовить» найдётся почти всегда.
      </p>
      {unavailable ? (
        <p className="muted small">Сервер пока не умеет загружать базу.</p>
      ) : running && s ? (
        <Progress s={s} />
      ) : (
        <>
          <Button icon="download" onClick={start} disabled={starting || status.isPending} className="lib__btn">
            {starting ? "Запускаю…" : "Загрузить базу из TheCocktailDB и TheMealDB"}
          </Button>
          {s?.finishedAt && (
            <p className="lib__line">
              Последний раз {formatDateTime(s.finishedAt)}: добавлено {s.imported}, уже было {s.skipped}
              {s.failed > 0 && `, не удалось ${s.failed}`}.
            </p>
          )}
          {s?.lastError && <p className="lib__line lib__line--error">{s.lastError}</p>}
        </>
      )}
      {status.isError && !unavailable && <p className="lib__line lib__line--error">{errorMessage(status.error)}</p>}
    </section>
  );
}
