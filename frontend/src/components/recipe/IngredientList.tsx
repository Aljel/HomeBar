import { memo, useMemo, type CSSProperties } from "react";
import type { Ingredient } from "../../api/types";
import { formatMeasure, measureText } from "../../lib/measure";
import { computeProportions, formatShare } from "../../lib/proportion";
import type { UnitSystem } from "../../lib/units";
import type { StockMark } from "../../lib/stock";
import { Icon } from "../Icon";
import { strataColor } from "./palette";
import "./ingredients.css";

interface Props {
  ingredients: readonly Ingredient[];
  factor: number;
  system: UnitSystem;
  activeIndex?: number | null;
  onActive?: (i: number | null) => void;
  /** colour markers + share column, synced with the proportion visual (recipe page) */
  withShares?: boolean;
  /** host: pantry mark per row (✓ in pantry / ○ missing) */
  marks?: readonly StockMark[];
}

const STOCK_TITLE = { have: "Есть дома", missing: "Нет дома", staple: "Вода и лёд — всегда есть" } as const;

export const IngredientList = memo(function IngredientList({ ingredients, factor, system, activeIndex = null, onActive, withShares, marks }: Props) {
  const shares = useMemo(() => {
    const m = new Map<number, number>();
    if (withShares) computeProportions(ingredients).parts.forEach((l) => m.set(l.index, l.share));
    return m;
  }, [ingredients, withShares]);

  if (ingredients.length === 0) return <p className="muted">Ингредиенты не указаны.</p>;

  return (
    <ul className={`ings ${withShares ? "ings--shares" : ""} ${marks ? "ings--stock" : ""} ${activeIndex !== null ? "has-active" : ""}`}>
      {ingredients.map((ing, i) => {
        const m = formatMeasure(ing, factor, system);
        const share = shares.get(i);
        const interactive = withShares && onActive && share !== undefined;
        return (
          <li
            key={i}
            className={`ings__row ${activeIndex === i ? "is-active" : ""}`}
            tabIndex={interactive ? 0 : undefined}
            onMouseEnter={interactive ? () => onActive(i) : undefined}
            onMouseLeave={interactive ? () => onActive(null) : undefined}
            onFocus={interactive ? () => onActive(i) : undefined}
            onBlur={interactive ? () => onActive(null) : undefined}
          >
            {withShares && (
              <span
                className={`ings__mark ${share === undefined ? "ings__mark--none" : ""}`}
                style={share !== undefined ? ({ "--c": strataColor(i) } as CSSProperties) : undefined}
                aria-hidden="true"
              />
            )}
            {marks && <StockCell mark={marks[i] ?? null} />}
            <span className="ings__name">
              {ing.name}
              {ing.note && <span className="ings__note">{ing.note}</span>}
            </span>
            <span className="ings__qty">{measureText(m) || <span className="ings__dash">по вкусу</span>}</span>
            {withShares && <span className="ings__share">{share !== undefined ? formatShare(share) : ""}</span>}
          </li>
        );
      })}
    </ul>
  );
});

function StockCell({ mark }: { mark: StockMark }) {
  if (!mark) return <span className="ings__stock" />;
  return (
    <span className={`ings__stock ings__stock--${mark}`} title={STOCK_TITLE[mark]}>
      {mark === "missing" ? <span className="ings__circle" aria-hidden="true" /> : <Icon name="check" />}
      <span className="visually-hidden">{STOCK_TITLE[mark]}</span>
    </span>
  );
}
