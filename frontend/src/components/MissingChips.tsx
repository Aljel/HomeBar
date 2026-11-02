import type { MissingIngredient } from "../api/types";
import { Icon } from "./Icon";

/** Missing ingredients as small muted chips; with `onAdd` each gets a + («у меня есть»). */
export function MissingChips({ missing, onAdd, disabled }: { missing: readonly MissingIngredient[]; onAdd?: (m: MissingIngredient) => void; disabled?: boolean }) {
  return (
    <ul className="miss" aria-label="Не хватает">
      {missing.map((m) => (
        <li key={m.key} className="miss__chip">
          <span>{m.name.toLowerCase()}</span>
          {onAdd && (
            <button type="button" className="miss__add" aria-label={`У меня есть: ${m.name}`} title="Есть дома — добавить в продукты" disabled={disabled} onClick={() => onAdd(m)}>
              <Icon name="plus" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
