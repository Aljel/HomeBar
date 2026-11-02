import { memo } from "react";
import { Link } from "react-router";
import type { Recipe, RecipeSummary } from "../api/types";
import { useToggleFavorite } from "../hooks/useRecipeActions";
import { useIsHost } from "../lib/auth";
import { KIND_LABEL, SOURCE_LABEL } from "../lib/format";
import { guessGlass } from "../lib/glass";
import { Button, ButtonLink, IconButton, IconLink } from "./Button";
import { Icon } from "./Icon";
import { Img } from "./Img";
import "./recipe-card.css";

type Variant = "feed" | "compact";

interface RecipeCardProps {
  recipe: RecipeSummary;
  variant?: Variant;
  /** host: open the "add to menu" dialog for this recipe */
  onAddToMenu?: (id: number) => void;
  eager?: boolean;
}

export const RecipeCard = memo(function RecipeCard({ recipe, variant = "feed", onAddToMenu, eager }: RecipeCardProps) {
  const isHost = useIsHost();
  const fav = useToggleFavorite();
  const href = `/recipes/${recipe.id}`;
  const glass = guessGlass({ kind: recipe.kind, title: recipe.title, ingredientNames: recipe.ingredientNames });
  const meta = [KIND_LABEL[recipe.kind], recipe.parentId !== null ? "вариация" : null, recipe.source !== "own" ? SOURCE_LABEL[recipe.source] : null].filter(Boolean);
  return (
    <article className={`card card--${variant}`}>
      <Link to={href} className="card__media" tabIndex={-1} aria-hidden="true">
        <Img src={recipe.imageUrl} alt="" thumb glass={glass} seed={recipe.id} eager={eager} ratio={variant === "compact" ? "4 / 3" : "16 / 10"} placeholderRatio={variant === "compact" ? "4 / 3" : "16 / 7"} />
      </Link>
      <div className="card__body">
        <p className="card__meta">{meta.join(" · ")}</p>
        <h3 className="card__title">
          <Link to={href}>{recipe.title}</Link>
        </h3>
        {recipe.description && <p className="card__desc">{recipe.description}</p>}
        {recipe.ingredientNames.length > 0 && <p className="card__ings">{recipe.ingredientNames.slice(0, 5).join(" · ")}</p>}
      </div>
      <div className="card__foot">
        {variant === "feed" && recipe.tags.length > 0 && (
          <span className="card__tags">
            {recipe.tags.slice(0, 3).map((t) => (
              <Link key={t} to={`/recipes?tag=${encodeURIComponent(t)}`} className="tag">
                #{t}
              </Link>
            ))}
          </span>
        )}
        <span className="card__actions">
          {isHost ? (
            <>
              <IconButton
                icon="heart"
                tone="heart"
                filled={recipe.favorite}
                aria-pressed={recipe.favorite}
                label={recipe.favorite ? "Убрать из избранного" : "В избранное"}
                disabled={fav.busyId === recipe.id}
                onClick={() => fav.toggle(recipe.id, !recipe.favorite)}
              />
              {onAddToMenu && <IconButton icon="plus" label="Добавить в меню" onClick={() => onAddToMenu(recipe.id)} />}
            </>
          ) : (
            recipe.favorite && (
              <span className="card__fav" title="Избранное">
                <Icon name="heart" filled />
                <span className="visually-hidden">Избранное</span>
              </span>
            )
          )}
          <IconLink icon="arrowRight" label={`Открыть «${recipe.title}»`} to={href} />
        </span>
      </div>
    </article>
  );
});

interface IdeaCardProps {
  recipe: Recipe;
  variant?: Variant;
  importing?: boolean;
  onImport?: (r: Recipe) => void;
  onOpen: (r: Recipe) => void;
}

/** A recipe from TheCocktailDB / TheMealDB, not saved (or already saved) locally. */
export const IdeaCard = memo(function IdeaCard({ recipe, variant = "feed", importing, onImport, onOpen }: IdeaCardProps) {
  const isHost = useIsHost();
  const glass = guessGlass({ kind: recipe.kind, glass: recipe.glass, title: recipe.title });
  const names = recipe.ingredients.map((i) => i.name).filter(Boolean);
  return (
    <article className={`card card--idea card--${variant}`}>
      <button type="button" className="card__media" tabIndex={-1} aria-hidden="true" onClick={() => onOpen(recipe)}>
        <Img src={recipe.imageUrl} alt="" thumb glass={glass} seed={`${recipe.source}:${recipe.sourceId}`} ratio={variant === "compact" ? "4 / 3" : "16 / 10"} />
      </button>
      <div className="card__body">
        <p className="card__meta">
          <span className="tag tag--web">
            <Icon name="globe" /> Из интернета
          </span>
          <span>{recipe.kind === "dish" ? "Блюдо" : "Коктейль"}</span>
          {recipe.glass && <span className="card__glass">{recipe.glass}</span>}
        </p>
        <h3 className="card__title">
          <button type="button" className="card__title-btn" onClick={() => onOpen(recipe)}>
            {recipe.title}
          </button>
        </h3>
        {names.length > 0 && <p className="card__ings">{names.slice(0, 5).join(" · ")}</p>}
      </div>
      <div className="card__foot">
        <span className="card__actions card__actions--start">
          {recipe.importedId !== null ? (
            <ButtonLink to={`/recipes/${recipe.importedId}`} variant="quiet" icon="check">
              Уже сохранено
            </ButtonLink>
          ) : (
            isHost &&
            onImport && (
              <Button icon="download" disabled={importing} onClick={() => onImport(recipe)}>
                {importing ? "Сохраняю…" : "Сохранить себе"}
              </Button>
            )
          )}
        </span>
        <span className="card__actions">
          <IconButton icon="arrowRight" label={`Подробнее: «${recipe.title}»`} onClick={() => onOpen(recipe)} />
        </span>
      </div>
    </article>
  );
});

export function CardSkeleton({ variant = "feed" }: { variant?: Variant }) {
  return (
    <div className={`card card--${variant} card--skeleton`} aria-hidden="true">
      <div className="card__media">
        <div className="skeleton" style={{ aspectRatio: variant === "compact" ? "4 / 3" : "16 / 10", borderRadius: 0 }} />
      </div>
      <div className="card__body">
        <div className="skeleton" style={{ height: 12, width: "30%" }} />
        <div className="skeleton" style={{ height: 22, width: "60%", marginTop: 10 }} />
        <div className="skeleton" style={{ height: 14, width: "85%", marginTop: 10 }} />
      </div>
    </div>
  );
}
