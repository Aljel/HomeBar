import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { api, isApiError } from "../api/client";
import { flattenRecipePages, keys, useActiveMenu, useAvailable, usePage, usePagedRecipes, useStats, useTags } from "../api/queries";
import type { Recipe } from "../api/types";
import { Button, ButtonLink } from "../components/Button";
import { IdeaDetails } from "../components/IdeaDetails";
import { Markdown } from "../components/Markdown";
import { PageEditor } from "../components/PageText";
import { CardSkeleton, IdeaCard, RecipeCard } from "../components/RecipeCard";
import { AddToMenuDialog } from "../components/recipe/AddToMenuDialog";
import { LoadMore } from "../components/LoadMore";
import { EmptyState, ErrorState, LoadingNote, Skeleton } from "../components/States";
import { useImport } from "../hooks/useRecipeActions";
import { useIsHost } from "../lib/auth";
import { FEED_FILTERS, feedPlan, feedSegments, interleave, parseFeedFilter, uniqueBy, type FeedFilter } from "../lib/feed";
import { plural } from "../lib/format";
import { splitIntro } from "../lib/intro";
import "./home.css";

const HOME_TITLE = "Домашний бар";
const HOME_FALLBACK = `Здесь собраны коктейли и блюда, которые я люблю готовить для друзей.

Гостям — **меню**: выберите напиток и закажите его прямо с телефона.`;

const IDEAS_PER_BATCH = 6;
const IDEA_EVERY = 4;
const FEED_PAGE = 24;

function Stats() {
  const s = useStats();
  if (s.isPending) return <Skeleton w={260} h={16} className="hero__stats-sk" />;
  if (s.isError) return null;
  const d = s.data;
  const parts = [
    `${d.recipes} ${plural(d.recipes, ["рецепт", "рецепта", "рецептов"])}`,
    `${d.cocktails} ${plural(d.cocktails, ["коктейль", "коктейля", "коктейлей"])}`,
    d.dishes > 0 ? `${d.dishes} ${plural(d.dishes, ["блюдо", "блюда", "блюд"])}` : null,
    d.favorites > 0 ? `${d.favorites} в избранном` : null,
  ].filter(Boolean);
  return <p className="hero__stats">{parts.join(" · ")}</p>;
}

function Hero() {
  const q = usePage("home");
  const isHost = useIsHost();
  const [editing, setEditing] = useState(false);
  const [more, setMore] = useState(false);

  if (editing && q.isSuccess) {
    return (
      <section className="hero panel panel--pad" aria-label="Текст на главной">
        <PageEditor slug="home" page={q.data} fallbackTitle={HOME_TITLE} fallbackBody={HOME_FALLBACK} onDone={() => setEditing(false)} />
      </section>
    );
  }

  const body = q.data?.body || HOME_FALLBACK;
  const intro = splitIntro(body);
  const title = intro.heading ?? q.data?.title ?? HOME_TITLE;

  return (
    <section className="hero" aria-labelledby="hero-title">
      <p className="eyebrow hero__eyebrow">HomeBar · домашний бар и кухня</p>
      {q.isPending ? (
        <div aria-busy="true">
          <Skeleton h={44} w="70%" />
          <Skeleton h={16} w="90%" className="hero__sk" />
          <Skeleton h={16} w="60%" className="hero__sk" />
        </div>
      ) : (
        <>
          <h1 id="hero-title" className="serif hero__title">
            {title}
          </h1>
          {intro.lead && <Markdown source={intro.lead} className={`hero__lead ${more ? "" : "hero__lead--clamp"}`} />}
          {intro.rest && more && <Markdown source={intro.rest} className="hero__more" />}
          {intro.rest && (
            <button type="button" className="hero__toggle" aria-expanded={more} onClick={() => setMore((v) => !v)}>
              {more ? "Свернуть" : "Читать дальше"}
            </button>
          )}
        </>
      )}
      <Stats />
      <div className="hero__actions">
        <ButtonLink to="/menu" variant="primary" icon="glass">
          Меню на сегодня
        </ButtonLink>
        <ButtonLink to="/recipes">Все рецепты</ButtonLink>
        {isHost && q.isSuccess && (
          <Button variant="quiet" icon="edit" onClick={() => setEditing(true)}>
            Изменить текст
          </Button>
        )}
      </div>
    </section>
  );
}

function FilterChips({ value, onChange }: { value: FeedFilter; onChange: (f: FeedFilter) => void }) {
  const isHost = useIsHost();
  return (
    <div className="chips chips--scroll feed__filters" role="group" aria-label="Что показать">
      {FEED_FILTERS.filter((f) => !f.host || isHost).map((f) => (
        <button key={f.value} type="button" className="chip" aria-pressed={value === f.value} onClick={() => onChange(f.value)}>
          {f.label}
        </button>
      ))}
    </div>
  );
}

const EMPTY: Record<FeedFilter, { title: string; text: string }> = {
  all: { title: "Рецептов пока нет", text: "Добавьте первый рецепт или сохраните что-нибудь из идей ниже." },
  makeable: { title: "Пока ничего не получается приготовить", text: "Отметьте, какие продукты есть дома, — и здесь появится всё, что из них выйдет." },
  cocktails: { title: "Коктейлей пока нет", text: "Загляните в «Попробуйте» — там много классики." },
  dishes: { title: "Блюд пока нет", text: "Сохраните идею из интернета или запишите свой рецепт." },
  favorites: { title: "В избранном пусто", text: "Отметьте любимые рецепты сердечком — они появятся здесь." },
  mine: { title: "Своих рецептов пока нет", text: "Запишите первый — это займёт пару минут." },
  ideas: { title: "", text: "" },
};

function Feed({ filter }: { filter: FeedFilter }) {
  const plan = feedPlan(filter);
  const isHost = useIsHost();
  const segments = feedSegments(plan.own);
  const own = usePagedRecipes(segments, FEED_PAGE, plan.own !== null);
  const makeable = useAvailable({ maxMissing: 0 }, FEED_PAGE, !!plan.makeable);
  const saved = plan.makeable ? makeable : own;
  const [batches, setBatches] = useState(1);
  const ideaKind = plan.ideas ?? "cocktail";
  const ideaQs = useQueries({
    queries: Array.from({ length: plan.ideas ? batches : 0 }, (_, i) => ({
      // negative nonces: the feed's own hands, separate from the /discover page
      queryKey: keys.discoverRandom(ideaKind, -(i + 1)),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.discoverRandom(ideaKind, IDEAS_PER_BATCH, signal),
      staleTime: Infinity,
      retry: (n: number, e: unknown) => !isApiError(e, 503) && !isApiError(e, 502) && n < 1,
    })),
  });
  const { busy, importRecipe } = useImport();
  const [details, setDetails] = useState<Recipe | null>(null);
  const [menuFor, setMenuFor] = useState<number | null>(null);

  const ideas = uniqueBy(
    ideaQs.flatMap((q) => q.data ?? []),
    (r) => `${r.source}:${r.sourceId ?? r.title}`,
  );
  const ideasError = ideaQs.find((q) => q.isError)?.error;
  const ideasOffline = ideasError !== undefined && (isApiError(ideasError, 503) || isApiError(ideasError, 502));
  const loadingMore = ideaQs.some((q) => q.isFetching);

  const ownList = plan.makeable ? (makeable.data?.pages.flatMap((p) => p.items.map((a) => a.recipe)) ?? []) : plan.own ? flattenRecipePages(own.data) : [];
  const entries = interleave(ownList, ideas, IDEA_EVERY);
  const hasSaved = plan.own !== null || !!plan.makeable;
  const ownPending = hasSaved && saved.isPending;
  const moreSaved = hasSaved && !!saved.hasNextPage;
  const ideasPending = plan.own === null && ideaQs[0]?.isPending;

  let body;
  if (ownPending || ideasPending) {
    body = (
      <div className="feed__list" aria-busy="true">
        <LoadingNote text="Загружаю ленту…" />
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  } else if (hasSaved && saved.isError) {
    body = <ErrorState error={saved.error} onRetry={() => saved.refetch()} />;
  } else if (plan.own === null && ideasError && ideas.length === 0) {
    body = ideasOffline ? (
      <EmptyState title="Интернет-источники недоступны">Бар сейчас работает офлайн. Все сохранённые рецепты на месте.</EmptyState>
    ) : (
      <ErrorState error={ideasError} onRetry={() => ideaQs[0]?.refetch()} />
    );
  } else {
    body = (
      <>
        {hasSaved && ownList.length === 0 && (
          <EmptyState
            title={EMPTY[filter].title}
            action={
              isHost && (filter === "all" || filter === "mine") ? (
                <ButtonLink to="/recipes/new" icon="plus">
                  Новый рецепт
                </ButtonLink>
              ) : filter === "makeable" ? (
                <ButtonLink to="/pantry" icon="plus">
                  Отметить продукты
                </ButtonLink>
              ) : undefined
            }
          >
            {EMPTY[filter].text}
          </EmptyState>
        )}
        <div className={`feed__list ${saved.isPlaceholderData ? "is-stale" : ""}`}>
          {entries.map((e, i) =>
            e.type === "own" ? (
              <RecipeCard key={`r${e.item.id}`} recipe={e.item} eager={i < 2} onAddToMenu={isHost ? setMenuFor : undefined} />
            ) : (
              <IdeaCard
                key={`i${e.item.source}:${e.item.sourceId ?? e.item.title}`}
                recipe={e.item}
                importing={busy === e.item.sourceId}
                onImport={importRecipe}
                onOpen={setDetails}
              />
            ),
          )}
        </div>
        {moreSaved && <LoadMore hasMore loading={saved.isFetchingNextPage} onMore={() => void saved.fetchNextPage()} />}
        <div className="feed__end" hidden={moreSaved}>
          {plan.ideas === null ? (
            ownList.length > 0 && <p className="feed__end-note">Это все рецепты.</p>
          ) : ideasOffline ? (
            <p className="feed__end-note">Идеи из интернета сейчас недоступны — бар работает офлайн.</p>
          ) : (
            <>
              <p className="feed__end-note">Хочется чего-то нового?</p>
              <Button icon="refresh" onClick={() => setBatches((n) => n + 1)} disabled={loadingMore}>
                {loadingMore ? "Ищу идеи…" : "Ещё идеи"}
              </Button>
            </>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      {body}
      <IdeaDetails recipe={details} onClose={() => setDetails(null)} onImport={importRecipe} busy={busy} />
      {isHost && <AddToMenuDialog recipeId={menuFor ?? 0} open={menuFor !== null} onClose={() => setMenuFor(null)} />}
    </>
  );
}

function Sidebar() {
  const menu = useActiveMenu();
  const tags = useTags();
  const isHost = useIsHost();
  return (
    <aside className="home__side" aria-label="Коротко">
      <section className="side-card">
        <h2 className="side-card__title">Сейчас в меню</h2>
        {menu.isPending ? (
          <div className="stack" style={{ ["--stack-gap" as string]: "8px" }}>
            <Skeleton h={14} w="70%" />
            <Skeleton h={14} w="50%" />
          </div>
        ) : menu.isError || menu.data === null || menu.data.items.length === 0 ? (
          <>
            <p className="muted small">Сегодня меню не выставлено.</p>
            {isHost && (
              <ButtonLink to="/bar" icon="plus">
                Составить меню
              </ButtonLink>
            )}
          </>
        ) : (
          <>
            <p className="side-card__sub">{menu.data.title}</p>
            <ul className="side-list">
              {menu.data.items.slice(0, 6).map((it) => (
                <li key={it.recipeId}>
                  <Link to={`/recipes/${it.recipeId}`}>{it.recipe.title}</Link>
                </li>
              ))}
            </ul>
            <ButtonLink to="/menu" icon="glass">
              Заказать
            </ButtonLink>
          </>
        )}
      </section>

      {tags.data && tags.data.length > 0 && (
        <section className="side-card">
          <h2 className="side-card__title">Теги</h2>
          <div className="chips">
            {tags.data.slice(0, 12).map((t) => (
              <Link key={t.tag} to={`/recipes?tag=${encodeURIComponent(t.tag)}`} className="tag">
                #{t.tag}
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="side-card">
        <h2 className="side-card__title">Попробуйте новое</h2>
        <p className="muted small">Случайные рецепты со всего света из TheCocktailDB и TheMealDB.</p>
        <ButtonLink to="/discover" iconEnd="arrowRight">
          Открыть идеи
        </ButtonLink>
      </section>
    </aside>
  );
}

export default function Home() {
  const [sp, setSp] = useSearchParams();
  const isHost = useIsHost();
  const parsed = parseFeedFilter(sp.get("f"));
  const filter = parsed === "makeable" && !isHost ? "all" : parsed;
  const setFilter = (f: FeedFilter) =>
    setSp(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (f === "all") next.delete("f");
        else next.set("f", f);
        return next;
      },
      { replace: true },
    );

  return (
    <div className="page home">
      <div className="home__grid">
        <div className="home__main">
          <Hero />
          <section className="feed" aria-label="Лента">
            <FilterChips value={filter} onChange={setFilter} />
            {/* keyed: each filter has its own idea batches */}
            <Feed key={filter} filter={filter} />
          </section>
        </div>
        <Sidebar />
      </div>
    </div>
  );
}
