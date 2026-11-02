import { useEffect, useId, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";
import { useIngredientSearch } from "../../api/queries";
import type { CatalogIngredient } from "../../api/types";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { useDebounced } from "../../hooks/useDebounced";
import type { AddResult } from "../../hooks/usePantryActions";
import { addedMessage, categoryLabel, isList, normalizeName, parseNames, suggestionMatches } from "../../lib/pantry";

interface Props {
  onAdd: (names: string[]) => Promise<AddResult | null>;
  busy?: boolean;
}

let msgSeq = 0;

type Option = { type: "catalog"; item: CatalogIngredient } | { type: "raw"; name: string };

/**
 * The one big input: autocomplete from the catalog (combobox pattern, aria-activedescendant),
 * Enter adds the highlighted product or the typed text, a pasted / comma-separated list adds everything at once.
 * After adding it clears and keeps focus, so products go in one after another.
 */
export function PantryInput({ onAdd, busy }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const hintId = useId();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  // keyboard position, remembered per query (a new query resets it to the default)
  const [nav, setNav] = useState<{ q: string; i: number } | null>(null);
  const [message, setMessage] = useState<{ id: number; text: string } | null>(null);

  const typed = text.trim();
  const listMode = isList(text);
  const q = useDebounced(listMode ? "" : typed, 150);
  const search = useIngredientSearch(q, !listMode);

  // stale results (keepPreviousData) are fine to show while typing, but only for a non-empty query
  const catalog = typed && !listMode ? (search.data ?? []) : [];
  const exact = catalog.some((c) => normalizeName(c.name) === normalizeName(typed) || normalizeName(c.nameEn) === normalizeName(typed));
  const options: Option[] = [
    ...catalog.map((item): Option => ({ type: "catalog", item })),
    ...(typed && !listMode && !exact ? [{ type: "raw", name: typed } as Option] : []),
  ];
  const first = catalog[0];
  const defaultIndex = first && suggestionMatches(typed, first) ? 0 : -1;
  const active = nav && nav.q === typed ? Math.min(nav.i, options.length - 1) : defaultIndex;
  const expanded = open && options.length > 0;
  const activeId = expanded && active >= 0 ? `${listId}-${active}` : undefined;

  // autofocus only where there is a real keyboard (no on-screen keyboard popping up on phones)
  useEffect(() => {
    if (window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) inputRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(() => setMessage(null), 6000);
    return () => window.clearTimeout(t);
  }, [message]);

  // keep the highlighted option visible
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  async function submitNames(names: string[]) {
    if (names.length === 0) return;
    setText("");
    setNav(null);
    setOpen(false);
    inputRef.current?.focus();
    const res = await onAdd(names);
    if (res) setMessage({ id: ++msgSeq, text: addedMessage(res.added, res.already) || "Готово" });
    else setText((t) => t || names.join(", ")); // failed: give the text back
  }

  function pick(o: Option) {
    if (o.type === "catalog" && o.item.inPantry) {
      setMessage({ id: ++msgSeq, text: `Уже есть: ${o.item.name.toLowerCase()}` });
      setText("");
      setNav(null);
      inputRef.current?.focus();
      return;
    }
    void submitNames([o.type === "catalog" ? o.item.name : o.name]);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const o = expanded && active >= 0 ? options[active] : undefined;
    if (o) pick(o);
    else void submitNames(parseNames(text));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (options.length === 0) return;
      e.preventDefault();
      if (!expanded) {
        setOpen(true);
        return;
      }
      const step = e.key === "ArrowDown" ? 1 : -1;
      // -1 = nothing highlighted (Enter adds the raw text)
      let i = active + step;
      if (i >= options.length) i = -1;
      if (i < -1) i = options.length - 1;
      setNav({ q: typed, i });
    } else if (e.key === "Escape") {
      if (expanded) {
        e.preventDefault();
        setOpen(false);
      } else if (text) {
        e.preventDefault();
        setText("");
      }
    }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData("text");
    if (!isList(pasted)) return;
    const names = parseNames(`${text},${pasted}`);
    if (names.length < 2) return;
    e.preventDefault();
    void submitNames(names);
  }

  return (
    <form className="pantry-input" onSubmit={onSubmit} aria-label="Добавить продукты">
      <label className="visually-hidden" htmlFor={`${listId}-input`}>
        Добавить продукт
      </label>
      <div className="pantry-input__box">
        <input
          ref={inputRef}
          id={`${listId}-input`}
          className="pantry-input__field"
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-describedby={hintId}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          placeholder="Например, лайм"
          value={text}
          maxLength={4000}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
        />
        <Button type="submit" variant="primary" icon="plus" className="pantry-input__add" disabled={!typed}>
          <span className="pantry-input__add-label">Добавить</span>
        </Button>
        <ul id={listId} role="listbox" aria-label="Подсказки" className="pantry-input__list" hidden={!expanded}>
          {options.map((o, i) => (
            <li
              key={o.type === "catalog" ? o.item.key : `raw:${o.name}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              aria-disabled={o.type === "catalog" && o.item.inPantry ? true : undefined}
              className={`pantry-option ${i === active ? "is-active" : ""} ${o.type === "raw" ? "pantry-option--raw" : ""}`}
              // keep focus in the input
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => i !== active && setNav({ q: typed, i })}
              onClick={() => pick(o)}
            >
              {o.type === "catalog" ? (
                <>
                  <span className="pantry-option__name">
                    {o.item.name}
                    {normalizeName(o.item.nameEn) !== normalizeName(o.item.name) && <span className="pantry-option__en"> · {o.item.nameEn}</span>}
                  </span>
                  <span className="pantry-option__meta">
                    {o.item.inPantry ? (
                      <>
                        <Icon name="check" /> уже есть
                      </>
                    ) : (
                      categoryLabel(o.item.category)
                    )}
                  </span>
                </>
              ) : (
                <span className="pantry-option__name">
                  Добавить «{o.name}»<span className="pantry-option__en"> · свой продукт</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
      <p id={hintId} className="pantry-input__hint">
        Enter — добавить. Можно вставить список через запятую или с новой строки.
      </p>
      <p className="pantry-input__msg" role="status" aria-live="polite">
        {message && (
          <span key={message.id} className="pantry-input__msg-text">
            <Icon name="check" /> {message.text}
          </span>
        )}
      </p>
      {busy && <span className="visually-hidden">Сохраняю…</span>}
    </form>
  );
}
