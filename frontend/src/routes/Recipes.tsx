import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { flattenRecipePages, useAvailable, usePagedRecipes, useTags } from "../api/queries";
import type { Kind, RecipeFilters } from "../api/types";
import { Button, ButtonLink } from "../components/Button";
import { Icon } from "../components/Icon";
import { CardSkeleton, RecipeCard } from "../components/RecipeCard";
import { AddToMenuDialog } from "../components/recipe/AddToMenuDialog";
import { LoadMore } from "../components/LoadMore";
import { EmptyState, ErrorState, LoadingNote } from "../components/States";
import { useIsHost } from "../lib/auth";
import { plural } from "../lib/format";
import "./recipes.css";

const KINDS: { value: Kind | ""; label: string }[] = [
  { value: "", label: "Все" },
  { value: "cocktail", label: "Коктейли" },
  { value: "dish", label: "Блюда" },
  { value: "other", label: "Другое" },
];
const SOURCES = [
  { value: "", label: "Любые" },
  { value: "own", label: "Свои" },
  { value: "imported", label: "Из интернета" },
] as const;

function readFilters(sp: URLSearchParams): RecipeFilters {
  const kind = sp.get("kind");
  const source = sp.get("source");
  return {
    q: sp.get("q")?.trim() || undefined,
    kind: kind === "cocktail" || kind === "dish" || kind === "other" ? kind : undefined,
    favorite: sp.get("favorite") === "1" || undefined,
    source: source === "own" || source === "imported" ? source : undefined,
    tag: sp.get("tag") || undefined,
  };
}

const PAGE = 48;

export default function Recipes() {
  const [sp, setSp] = useSearchParams();
  const filters = useMemo(() => readFilters(sp), [sp]);
  const isHost = useIsHost();
  // host: «Можно приготовить» — only recipes fully covered by the pantry (/api/available)
  const makeable = isHost && sp.get("can") === "1";
  const segments = useMemo(() => [filters], [filters]);
  const paged = usePagedRecipes(segments, PAGE, !makeable);
  const avail = useAvailable(
    { kind: filters.kind === "cocktail" || filters.kind === "dish" ? filters.kind : undefined, maxMissing: 0, q: filters.q, tag: filters.tag },
    PAGE,
    makeable,
  );
  const recipes = makeable ? avail : paged;
  const list = makeable ? (avail.data?.pages.flatMap((p) => p.items.map((a) => a.recipe)) ?? []) : flattenRecipePages(paged.data);
  const total = recipes.data?.pages[0]?.total;
  const tags = useTags();
  const [showAllTags, setShowAllTags] = useState(false);
  const [menuFor, setMenuFor] = useState<number | null>(null);

  // search box: local state, debounced into the URL
  const [q, setQ] = useState(filters.q ?? "");
  const [lastUrlQ, setLastUrlQ] = useState(filters.q ?? "");
  if ((filters.q ?? "") !== lastUrlQ) {
    // URL changed from outside (back button, link): follow it
    setLastUrlQ(filters.q ?? "");
    setQ(filters.q ?? "");
  }
  useEffect(() => {
    if (q.trim() === (filters.q ?? "")) return;
    const t = window.setTimeout(() => {
      setSp(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (q.trim()) next.set("q", q.trim());
          else next.delete("q");
          return next;
        },
        { replace: true },
      );
    }, 300);
    return () => window.clearTimeout(t);
  }, [q, filters.q, setSp]);

  function setParam(key: string, value: string | null) {
    setSp(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  }

  const activeCount = [filters.q, filters.kind, filters.favorite, filters.source, filters.tag, makeable].filter(Boolean).length;
  const tagList = tags.data ?? [];
  const visibleTags = showAllTags ? tagList : tagList.slice(0, 14);
  const reset = () => setSp(new URLSearchParams(), { replace: true });

  return (
    <div className="page catalogue">
      <header className="page-head">
        <h1 className="serif">Рецепты</h1>
        {isHost && (
          <div className="page-head__actions">
            <ButtonLink to="/recipes/new" variant="primary" icon="plus">
              Новый рецепт
            </ButtonLink>
          </div>
        )}
      </header>

      <section className="filters" aria-label="Фильтры">
        <label className="search filters__search">
          <span className="visually-hidden">Поиск по рецептам</span>
          <Icon name="search" />
          <input
            type="search"
            placeholder="Название, описание или ингредиент"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            enterKeyHint="search"
          />
        </label>

        <div className="chips chips--scroll filters__row">
          {isHost && (
            <>
              <button type="button" className="chip chip--can" aria-pressed={makeable} onClick={() => setParam("can", makeable ? null : "1")}>
                <Icon name="check" /> Можно приготовить
              </button>
              <span className="filters__sep" aria-hidden="true" />
            </>
          )}
          <div className="filters__group" role="group" aria-label="Тип">
            {KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                className="chip"
                aria-pressed={(filters.kind ?? "") === k.value}
                disabled={makeable && k.value === "other"}
                onClick={() => setParam("kind", k.value || null)}
              >
                {k.label}
              </button>
            ))}
          </div>
          <span className="filters__sep" aria-hidden="true" />
          <div className="filters__group" role="group" aria-label="Происхождение">
            {SOURCES.map((s) => (
              <button
                key={s.value}
                type="button"
                className="chip"
                aria-pressed={!makeable && (filters.source ?? "") === s.value}
                disabled={makeable}
                onClick={() => setParam("source", s.value || null)}
              >
                {s.label}
              </button>
            ))}
            <button type="button" className="chip" aria-pressed={!makeable && !!filters.favorite} disabled={makeable} onClick={() => setParam("favorite", filters.favorite ? null : "1")}>
              <Icon name="heart" filled={!!filters.favorite} /> Избранное
            </button>
          </div>
        </div>

        {tagList.length > 0 && (
          <div className="chips filters__tags" role="group" aria-label="Теги">
            {visibleTags.map((t) => (
              <button
                key={t.tag}
                type="button"
                className="chip chip--tag"
                aria-pressed={filters.tag === t.tag}
                onClick={() => setParam("tag", filters.tag === t.tag ? null : t.tag)}
              >
                #{t.tag} <span className="chip__count">{t.count}</span>
              </button>
            ))}
            {tagList.length > 14 && (
              <button type="button" className="chip chip--more" onClick={() => setShowAllTags((v) => !v)} aria-expanded={showAllTags}>
                {showAllTags ? "Свернуть" : `Ещё ${tagList.length - 14}`}
              </button>
            )}
          </div>
        )}

        <div className="filters__status">
          <span className="muted small" aria-live="polite">
            {total !== undefined ? `${total} ${plural(total, ["рецепт", "рецепта", "рецептов"])}` : "…"}
            {makeable && total !== undefined && " можно приготовить из того, что есть"}
          </span>
          {activeCount > 0 && (
            <Button variant="quiet" icon="close" onClick={reset}>
              Сбросить фильтры
            </Button>
          )}
        </div>
      </section>

      {recipes.isPending ? (
        <div className="catalogue__grid" aria-busy="true">
          <LoadingNote text="Загружаю рецепты…" />
          {Array.from({ length: 6 }, (_, i) => (
            <CardSkeleton key={i} variant="compact" />
          ))}
        </div>
      ) : recipes.isError ? (
        <ErrorState error={recipes.error} onRetry={() => recipes.refetch()} />
      ) : list.length === 0 ? (
        makeable ? (
          <EmptyState
            title="Пока ничего не получается"
            action={
              <ButtonLink to="/pantry" icon="plus">
                Отметить продукты
              </ButtonLink>
            }
          >
            По этим условиям из продуктов в доме ничего не выходит.
          </EmptyState>
        ) : activeCount > 0 ? (
          <EmptyState art="search" title="Ничего не нашлось" action={<Button onClick={reset}>Сбросить фильтры</Button>}>
            По этим условиям рецептов нет.
          </EmptyState>
        ) : (
          <EmptyState
            title="Рецептов пока нет"
            action={
              <div className="row" style={{ justifyContent: "center" }}>
                <ButtonLink to="/discover">Найти в интернете</ButtonLink>
                {isHost && (
                  <ButtonLink to="/recipes/new" variant="primary" icon="plus">
                    Первый рецепт
                  </ButtonLink>
                )}
              </div>
            }
          >
            Запишите свой рецепт или сохраните что-нибудь из «Попробуйте».
          </EmptyState>
        )
      ) : (
        <>
          <div className={`catalogue__grid ${recipes.isPlaceholderData ? "is-stale" : ""}`}>
            {list.map((r, i) => (
              <RecipeCard key={r.id} recipe={r} variant="compact" eager={i < 6} onAddToMenu={isHost ? setMenuFor : undefined} />
            ))}
          </div>
          <LoadMore hasMore={!!recipes.hasNextPage} loading={recipes.isFetchingNextPage} onMore={() => void recipes.fetchNextPage()} />
        </>
      )}
      {isHost && <AddToMenuDialog recipeId={menuFor ?? 0} open={menuFor !== null} onClose={() => setMenuFor(null)} />}
    </div>
  );
}
