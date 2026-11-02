import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api, isApiError } from "../api/client";
import { keys } from "../api/queries";
import type { DiscoverKind, Recipe } from "../api/types";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { IdeaDetails } from "../components/IdeaDetails";
import { CardSkeleton, IdeaCard } from "../components/RecipeCard";
import { EmptyState, ErrorState, LoadingNote } from "../components/States";
import { useImport } from "../hooks/useRecipeActions";
import "./discover.css";

const COUNT = 6;

function Offline({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (isApiError(error, 503))
    return (
      <EmptyState title="Бар работает офлайн">
        Поиск по интернету выключен. Все сохранённые рецепты — в разделе <Link to="/recipes">«Рецепты»</Link>.
      </EmptyState>
    );
  return <ErrorState error={error} onRetry={onRetry} title="Не удалось получить идеи" />;
}

export default function Discover() {
  const [sp, setSp] = useSearchParams();
  const kind: DiscoverKind = sp.get("kind") === "dish" ? "dish" : "cocktail";
  const urlQ = sp.get("q")?.trim() ?? "";
  const [draft, setDraft] = useState(urlQ);
  const [lastUrlQ, setLastUrlQ] = useState(urlQ);
  if (urlQ !== lastUrlQ) {
    // URL changed from outside (back/forward): follow it in the search box
    setLastUrlQ(urlQ);
    setDraft(urlQ);
  }
  const [nonce, setNonce] = useState(0);
  const [details, setDetails] = useState<Recipe | null>(null);
  const { busy, importRecipe } = useImport();

  const random = useQuery({
    queryKey: keys.discoverRandom(kind, nonce),
    queryFn: ({ signal }) => api.discoverRandom(kind, COUNT, signal),
    enabled: !urlQ,
    staleTime: Infinity,
    retry: (n, e) => !isApiError(e, 503) && n < 1,
  });
  const search = useQuery({
    queryKey: keys.discoverSearch(urlQ, kind),
    queryFn: ({ signal }) => api.discoverSearch(urlQ, kind, signal),
    enabled: !!urlQ,
    staleTime: 5 * 60_000,
    retry: (n, e) => !isApiError(e, 503) && n < 1,
  });

  function setKind(k: DiscoverKind) {
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      if (k === "dish") next.set("kind", "dish");
      else next.delete("kind");
      return next;
    });
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      if (draft.trim()) next.set("q", draft.trim());
      else next.delete("q");
      return next;
    });
  }
  function clearSearch() {
    setDraft("");
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("q");
      return next;
    });
  }

  const active = urlQ ? search : random;

  return (
    <div className="page discover">
      <header className="page-head">
        <h1 className="serif">Попробуйте</h1>
        <p className="page-head__lead">Случайные рецепты из TheCocktailDB и TheMealDB. Понравилось — сохраните себе.</p>
      </header>

      <div className="discover__bar">
        <div className="segmented" role="group" aria-label="Что ищем">
          <button type="button" className="segmented__btn" aria-pressed={kind === "cocktail"} onClick={() => setKind("cocktail")}>
            Коктейли
          </button>
          <button type="button" className="segmented__btn" aria-pressed={kind === "dish"} onClick={() => setKind("dish")}>
            Блюда
          </button>
        </div>
        <form className="discover__search" role="search" onSubmit={submit}>
          <label className="search">
            <span className="visually-hidden">Поиск в интернете</span>
            <Icon name="search" />
            <input
              type="search"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={kind === "dish" ? "pasta, curry… (по-английски)" : "margarita, negroni… (по-английски)"}
              enterKeyHint="search"
            />
          </label>
          <Button type="submit">Найти</Button>
        </form>
      </div>

      {urlQ && (
        <div className="discover__status">
          <span className="muted small">
            Поиск: «{urlQ}»{search.data && ` · ${search.data.length}`}
          </span>
          <Button variant="quiet" icon="close" onClick={clearSearch}>
            К случайным
          </Button>
        </div>
      )}

      {active.isPending ? (
        <div className="discover__grid" aria-busy="true">
          <LoadingNote text="Ищу идеи…" />
          {Array.from({ length: COUNT }, (_, i) => (
            <CardSkeleton key={i} variant="compact" />
          ))}
        </div>
      ) : active.isError ? (
        <Offline error={active.error} onRetry={() => active.refetch()} />
      ) : active.data.length === 0 ? (
        <EmptyState art="search" title="Ничего не нашлось" action={<Button onClick={clearSearch}>Случайные идеи</Button>}>
          Попробуйте другое слово — поиск понимает английские названия.
        </EmptyState>
      ) : (
        <div className={`discover__grid ${random.isFetching && !urlQ ? "is-stale" : ""}`} key={`${kind}-${nonce}-${urlQ}`}>
          {active.data.map((r) => (
            <IdeaCard
              key={`${r.source}:${r.sourceId ?? r.title}`}
              recipe={r}
              variant="compact"
              importing={busy === r.sourceId}
              onImport={importRecipe}
              onOpen={setDetails}
            />
          ))}
        </div>
      )}

      {!urlQ && !active.isError && (
        <div className="discover__more">
          <Button icon="refresh" onClick={() => setNonce((n) => n + 1)} disabled={random.isFetching}>
            {random.isFetching && !random.isPending ? "Ищу идеи…" : "Ещё идеи"}
          </Button>
        </div>
      )}

      <IdeaDetails recipe={details} onClose={() => setDetails(null)} onImport={importRecipe} busy={busy} />
    </div>
  );
}
