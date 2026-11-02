import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, isApiError } from "../api/client";
import { keys, useRecipe } from "../api/queries";
import type { LocalRecipe, Recipe } from "../api/types";
import { Button, ButtonLink, IconButton } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Icon } from "../components/Icon";
import { Img } from "../components/Img";
import { Markdown } from "../components/Markdown";
import { AddToMenuDialog } from "../components/recipe/AddToMenuDialog";
import { ServingsStepper, UnitToggle } from "../components/recipe/Controls";
import { IngredientList } from "../components/recipe/IngredientList";
import { Proportions } from "../components/recipe/Proportions";
import { VersionsDrawer } from "../components/recipe/VersionsDrawer";
import { EmptyState, ErrorState, LoadingNote, Skeleton } from "../components/States";
import { MissingChips } from "../components/MissingChips";
import { usePantryActions } from "../hooks/usePantryActions";
import { useRecipeAvailability } from "../hooks/useRecipeAvailability";
import { useToggleFavorite } from "../hooks/useRecipeActions";
import { useIsHost } from "../lib/auth";
import { KIND_LABEL, SOURCE_LABEL, formatDate } from "../lib/format";
import { guessGlass } from "../lib/glass";
import { formatNumber, scaleFactor } from "../lib/measure";
import { useUnitSystem } from "../lib/prefs";
import { toastError, toastSuccess } from "../lib/toast";
import "./recipe.css";

const METHOD_LABEL: Record<string, string> = {
  shake: "шейк",
  stir: "стир",
  build: "билд",
  blend: "бленд",
  muddle: "мадл",
  throw: "сроу",
};

function RecipeSkeleton() {
  return (
    <div className="recipe-article panel" aria-busy="true">
      <LoadingNote text="Загружаю рецепт…" />
      <div className="skeleton" style={{ aspectRatio: "16 / 9", borderRadius: 0 }} />
      <div className="recipe-head">
        <Skeleton h={12} w={160} />
        <Skeleton h={44} w="60%" className="sk-gap" />
        <Skeleton h={16} w="80%" className="sk-gap" />
      </div>
      <div className="recipe-section">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} h={20} className="sk-gap" />
        ))}
      </div>
    </div>
  );
}

function RecipeView({ recipe }: { recipe: LocalRecipe }) {
  const isHost = useIsHost();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [system, setSystem] = useUnitSystem();
  const [servings, setServings] = useState(recipe.servings);
  const [active, setActive] = useState<number | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState<"fork" | "delete" | null>(null);
  const fav = useToggleFavorite();
  const stock = useRecipeAvailability(recipe, isHost);
  const pantryActions = usePantryActions();

  const factor = scaleFactor(recipe.servings, servings);
  const glass = guessGlass({ kind: recipe.kind, glass: recipe.glass, title: recipe.title, ingredientNames: recipe.ingredients.map((i) => i.name) });

  async function fork() {
    setBusy("fork");
    try {
      const r = await api.forkRecipe(recipe.id);
      qc.setQueryData(keys.recipe(r.id), r);
      qc.invalidateQueries({ queryKey: keys.recipesAll });
      qc.invalidateQueries({ queryKey: keys.availableAll });
      qc.invalidateQueries({ queryKey: keys.pantrySuggestionsAll });
      qc.invalidateQueries({ queryKey: keys.stats });
      qc.invalidateQueries({ queryKey: keys.tags });
      toastSuccess("Вариация создана — подправьте её под себя.");
      navigate(`/recipes/${r.id}/edit`);
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("delete");
    try {
      await api.deleteRecipe(recipe.id);
      qc.removeQueries({ queryKey: keys.recipe(recipe.id) });
      qc.invalidateQueries({ queryKey: keys.recipesAll });
      qc.invalidateQueries({ queryKey: keys.availableAll });
      qc.invalidateQueries({ queryKey: keys.pantrySuggestionsAll });
      qc.invalidateQueries({ queryKey: keys.stats });
      qc.invalidateQueries({ queryKey: keys.menus });
      qc.invalidateQueries({ queryKey: keys.tags });
      // cached discover results must not keep linking to the deleted local copy
      // (patched in place: refetching would deal a new random hand)
      const unlink = (x: Recipe) => (x.importedId === recipe.id ? { ...x, importedId: null } : x);
      qc.setQueriesData<Recipe[] | Recipe>({ queryKey: ["discover"] }, (old) =>
        old === undefined ? old : Array.isArray(old) ? old.map(unlink) : unlink(old),
      );
      toastSuccess(`«${recipe.title}» удалён.`);
      navigate("/recipes");
    } catch (e) {
      toastError(errorMessage(e));
      setBusy(null);
    }
  }

  const meta: [string, string][] = [];
  if (recipe.glass) meta.push(["Бокал", recipe.glass]);
  if (recipe.method) meta.push(["Метод", METHOD_LABEL[recipe.method.toLowerCase()] ?? recipe.method]);
  if (recipe.garnish) meta.push(["Гарнир", recipe.garnish]);
  const kicker = [KIND_LABEL[recipe.kind], recipe.source !== "own" ? `из ${SOURCE_LABEL[recipe.source]}` : null].filter(Boolean).join(" · ");

  return (
    <>
      <nav className="recipe-top" aria-label="Навигация">
        <ButtonLink to="/recipes" variant="quiet" icon="arrowLeft">
          Все рецепты
        </ButtonLink>
      </nav>

      <article className="recipe-article panel" aria-labelledby="recipe-title">
        <Img
          src={recipe.imageUrl}
          alt={recipe.title}
          glass={glass}
          seed={recipe.id}
          ratio="16 / 9"
          placeholderRatio="5 / 2"
          eager
          width={1200}
          height={675}
          className="recipe-photo"
        />

        <header className="recipe-head">
          <p className="eyebrow">{kicker}</p>
          <h1 id="recipe-title" className="serif recipe-head__title">
            {recipe.title}
            {recipe.favorite && (
              <span className="recipe-head__fav" title="В избранном">
                <Icon name="heart" filled />
                <span className="visually-hidden">(в избранном)</span>
              </span>
            )}
          </h1>
          {recipe.description && <p className="recipe-head__desc">{recipe.description}</p>}
          {recipe.parentId !== null && (
            <p className="recipe-head__parent">
              <Icon name="branch" /> Вариация рецепта — <Link to={`/recipes/${recipe.parentId}`}>открыть исходный</Link>
            </p>
          )}
          {recipe.tags.length > 0 && (
            <p className="recipe-head__tags">
              {recipe.tags.map((t) => (
                <Link key={t} to={`/recipes?tag=${encodeURIComponent(t)}`} className="tag">
                  #{t}
                </Link>
              ))}
            </p>
          )}
          <div className="recipe-actions" role="group" aria-label="Действия с рецептом">
            <Button icon="history" onClick={() => setVersionsOpen(true)}>
              История
            </Button>
            {isHost && (
              <>
                <Button
                  icon="heart"
                  className={recipe.favorite ? "is-fav" : undefined}
                  onClick={() => fav.toggle(recipe.id, !recipe.favorite)}
                  disabled={fav.busyId === recipe.id}
                  aria-pressed={recipe.favorite}
                >
                  {recipe.favorite ? "В избранном" : "В избранное"}
                </Button>
                <Button icon="plus" onClick={() => setMenuOpen(true)}>
                  В меню
                </Button>
                <Button icon="branch" onClick={fork} disabled={busy === "fork"}>
                  {busy === "fork" ? "Создаю…" : "Вариация"}
                </Button>
                <ButtonLink to={`/recipes/${recipe.id}/edit`} icon="edit">
                  Править
                </ButtonLink>
                <IconButton icon="trash" label="Удалить рецепт" look="plain" tone="danger" className="recipe-actions__del" onClick={() => setDeleteOpen(true)} />
              </>
            )}
          </div>
        </header>

        <section className="recipe-section recipe-ings" aria-labelledby="ings-title">
          <div className="recipe-ings__main">
            <div className="recipe-ings__head">
              <h2 id="ings-title" className="recipe-h2">
                Состав
              </h2>
              <span className="spacer" />
              <ServingsStepper value={servings} base={recipe.servings} onChange={setServings} />
              <UnitToggle value={system} onChange={setSystem} />
            </div>
            <IngredientList
              ingredients={recipe.ingredients}
              factor={factor}
              system={system}
              activeIndex={active}
              onActive={setActive}
              withShares
              marks={stock.data?.marks}
            />
            {stock.data && (
              <div className={`recipe-stock ${stock.data.missing.length === 0 ? "recipe-stock--ok" : ""}`} aria-live="polite">
                {stock.data.missing.length === 0 ? (
                  <p className="recipe-stock__ok">
                    <Icon name="check" /> Всё есть дома — можно готовить.
                  </p>
                ) : (
                  <>
                    <span className="recipe-stock__label">Не хватает:</span>
                    <MissingChips missing={stock.data.missing} onAdd={(m) => void pantryActions.add([m.name])} disabled={pantryActions.busy} />
                    <Link to="/pantry" className="recipe-stock__link">
                      Продукты
                    </Link>
                  </>
                )}
              </div>
            )}
            {servings !== recipe.servings && (
              <p className="recipe-note">
                Пересчитано с {formatNumber(recipe.servings)} на {formatNumber(servings)} порц.
              </p>
            )}
            {meta.length > 0 && (
              <dl className="recipe-meta">
                {meta.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          <div className="recipe-ings__visual">
            <Proportions ingredients={recipe.ingredients} glass={glass} activeIndex={active} onActive={setActive} />
          </div>
        </section>

        <section className="recipe-section recipe-method" aria-labelledby="method-title">
          <h2 id="method-title" className="recipe-h2">
            Приготовление
          </h2>
          {recipe.instructions ? <Markdown source={recipe.instructions} /> : <p className="muted">Способ приготовления пока не записан.</p>}
          <p className="recipe-foot">
            Обновлено {formatDate(recipe.updatedAt)}
            {recipe.sourceUrl && (
              <>
                {" · "}
                <a href={recipe.sourceUrl} target="_blank" rel="noopener noreferrer">
                  источник
                </a>
              </>
            )}
          </p>
        </section>
      </article>

      <VersionsDrawer recipeId={recipe.id} open={versionsOpen} onClose={() => setVersionsOpen(false)} />
      {isHost && <AddToMenuDialog recipeId={recipe.id} open={menuOpen} onClose={() => setMenuOpen(false)} />}
      <ConfirmDialog
        open={deleteOpen}
        title="Удалить рецепт?"
        confirmLabel="Удалить"
        danger
        busy={busy === "delete"}
        onConfirm={remove}
        onClose={() => setDeleteOpen(false)}
      >
        <p>«{recipe.title}» пропадёт из рецептов и из всех меню. Уже сделанные заказы сохранят название.</p>
      </ConfirmDialog>
    </>
  );
}

export default function RecipePage() {
  const { id } = useParams();
  const recipeId = Number(id);
  const q = useRecipe(Number.isInteger(recipeId) ? recipeId : 0);

  if (!Number.isInteger(recipeId) || recipeId <= 0 || (q.isError && isApiError(q.error, 404))) {
    return (
      <div className="page page--narrow">
        <EmptyState title="Рецепт не найден" action={<ButtonLink to="/recipes">Все рецепты</ButtonLink>}>
          Такого рецепта нет — возможно, его удалили.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="page recipe">
      {q.isPending ? (
        <RecipeSkeleton />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        // the servings stepper is local state seeded from the base yield: reset it when a restore changes that base
        <RecipeView key={`${q.data.id}:${q.data.servings}`} recipe={q.data} />
      )}
    </div>
  );
}
