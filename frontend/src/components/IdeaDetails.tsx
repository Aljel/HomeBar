import { useQuery } from "@tanstack/react-query";
import { api, errorMessage } from "../api/client";
import { keys } from "../api/queries";
import type { Recipe } from "../api/types";
import { useIsHost } from "../lib/auth";
import { guessGlass } from "../lib/glass";
import { useUnitSystem } from "../lib/prefs";
import { Button, ButtonLink, buttonClass } from "./Button";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";
import { Img } from "./Img";
import { Markdown } from "./Markdown";
import { IngredientList } from "./recipe/IngredientList";
import "./idea-details.css";

interface Props {
  recipe: Recipe | null;
  onClose: () => void;
  onImport: (r: Recipe) => void;
  busy: string | null;
}

/** Bottom sheet with the full internet recipe and a "save" action for the host. */
export function IdeaDetails({ recipe, onClose, onImport, busy }: Props) {
  const isHost = useIsHost();
  const [system] = useUnitSystem();
  const source = recipe?.source ?? "thecocktaildb";
  const sourceId = recipe?.sourceId ?? "";
  // lookup gives the freshest full record (and importedId); the card data shows instantly meanwhile
  const q = useQuery({
    queryKey: keys.discoverLookup(source, sourceId),
    queryFn: ({ signal }) => api.discoverLookup(source, sourceId, signal),
    enabled: !!recipe && !!sourceId,
    placeholderData: recipe ?? undefined,
    staleTime: 5 * 60_000,
  });
  const r = q.data ?? recipe;
  return (
    <Dialog open={!!recipe} onClose={onClose} title={r?.title ?? ""} variant="sheet">
      {r && (
        <div className="idea">
          <div className="idea__top">
            <div className="idea__media">
              <Img src={r.imageUrl} alt={r.title} glass={guessGlass({ kind: r.kind, glass: r.glass, title: r.title })} seed={`${r.source}:${r.sourceId}`} ratio="1 / 1" width={600} height={600} />
            </div>
            <div className="idea__info">
              <p className="idea__meta">
                <span className="tag tag--web">
                  <Icon name="globe" /> Из интернета
                </span>
                <span>{r.source === "thecocktaildb" ? "TheCocktailDB" : "TheMealDB"}</span>
              </p>
              {r.glass && <p className="idea__glass muted small">Бокал: {r.glass}</p>}
              {r.tags.length > 0 && (
                <p className="idea__tags">
                  {r.tags.slice(0, 6).map((t) => (
                    <span key={t} className="tag">
                      {t}
                    </span>
                  ))}
                </p>
              )}
            </div>
          </div>
          <section aria-label="Состав">
            <h3 className="idea__h">Состав</h3>
            <IngredientList ingredients={r.ingredients} factor={1} system={system} />
          </section>
          {q.isError && <p className="field-error">Не удалось обновить данные: {errorMessage(q.error)}</p>}
          {r.instructions && (
            <section>
              <h3 className="idea__h">Приготовление</h3>
              <Markdown source={r.instructions} />
            </section>
          )}
          <div className="idea__actions">
            {r.importedId !== null ? (
              <ButtonLink to={`/recipes/${r.importedId}`} variant="primary" icon="check">
                Уже сохранено — открыть
              </ButtonLink>
            ) : isHost ? (
              <Button variant="primary" icon="download" disabled={busy === r.sourceId} onClick={() => onImport(r)}>
                {busy === r.sourceId ? "Сохраняю…" : "Сохранить себе"}
              </Button>
            ) : (
              <span className="muted small">Сохранить рецепт может хозяин.</span>
            )}
            {r.sourceUrl && (
              <a className={buttonClass({}, "")} href={r.sourceUrl} target="_blank" rel="noopener noreferrer">
                <span className="btn__label">Источник</span>
                <Icon name="external" />
              </a>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
