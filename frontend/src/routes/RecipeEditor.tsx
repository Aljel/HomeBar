import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useBlocker, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, isApiError } from "../api/client";
import { keys, useRecipe, useTags } from "../api/queries";
import type { Ingredient, Kind, LocalRecipe, RecipeInput } from "../api/types";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Button, ButtonLink, IconButton, buttonClass } from "../components/Button";
import { Icon } from "../components/Icon";
import { Img } from "../components/Img";
import { Markdown } from "../components/Markdown";
import { EmptyState, ErrorState, LoadingNote, Skeleton } from "../components/States";
import { useIsHost } from "../lib/auth";
import { requestLogin } from "../lib/loginRequest";
import { guessGlass } from "../lib/glass";
import { amountToInput, parseAmount } from "../lib/measure";
import { toastError, toastSuccess } from "../lib/toast";
import "./editor.css";

interface Row {
  key: number;
  name: string;
  amount: string;
  unit: string;
  note: string;
}

interface FormState {
  title: string;
  kind: Kind;
  description: string;
  instructions: string;
  imageUrl: string;
  servings: string;
  glass: string;
  garnish: string;
  method: string;
  tags: string[];
  favorite: boolean;
  rows: Row[];
  versionNote: string;
}

const UNITS = ["ml", "cl", "oz", "dash", "tsp", "tbsp", "barspoon", "shot", "g", "kg", "pcs", "slice", "pinch", ""];
const METHODS = ["shake", "stir", "build", "blend", "muddle", "throw"];
const KINDS: { value: Kind; label: string }[] = [
  { value: "cocktail", label: "Коктейль" },
  { value: "dish", label: "Блюдо" },
  { value: "other", label: "Другое" },
];

let rowSeq = 0;
const newRow = (i?: Partial<Ingredient>): Row => ({
  key: ++rowSeq,
  name: i?.name ?? "",
  amount: amountToInput(i?.amount ?? null),
  unit: i?.unit ?? "ml",
  note: i?.note ?? "",
});

function initialState(r: LocalRecipe | null): FormState {
  return {
    title: r?.title ?? "",
    kind: r?.kind ?? "cocktail",
    description: r?.description ?? "",
    instructions: r?.instructions ?? "",
    imageUrl: r?.imageUrl ?? "",
    servings: String(r?.servings ?? 1),
    glass: r?.glass ?? "",
    garnish: r?.garnish ?? "",
    method: r?.method ?? "",
    tags: r?.tags ?? [],
    favorite: r?.favorite ?? false,
    rows: r && r.ingredients.length > 0 ? r.ingredients.map(newRow) : [newRow(), newRow()],
    versionNote: "",
  };
}

/** Comparable snapshot of the form (row keys are UI-only). */
function snapshot(f: FormState): string {
  return JSON.stringify({ ...f, rows: f.rows.map(({ key: _key, ...rest }) => rest) });
}

/** Warns before leaving with unsaved changes: in-app navigation (router blocker) and tab close/reload. */
function useUnsavedGuard(dirty: boolean) {
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirtyRef.current && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
  );
  /** call right before a deliberate navigation (after a successful save) */
  const release = () => {
    dirtyRef.current = false;
  };
  return { blocker, release };
}

type Errors = Partial<Record<"title" | "servings" | "description" | "instructions" | "ingredients" | "tags", string>> & {
  rows?: Record<number, string>;
};

function validate(f: FormState): Errors {
  const e: Errors = {};
  const title = f.title.trim();
  if (!title) e.title = "Как назовём рецепт?";
  else if (title.length > 200) e.title = "Не длиннее 200 символов.";
  const s = parseAmount(f.servings);
  if (s === null || Number.isNaN(s) || s <= 0 || s > 1000) e.servings = "Число от 0 до 1000.";
  if (f.description.length > 2000) e.description = "Не длиннее 2000 символов.";
  if (f.instructions.length > 20000) e.instructions = "Не длиннее 20000 символов.";
  if (f.tags.length > 30) e.tags = "Не больше 30 тегов.";
  const filled = f.rows.filter((r) => r.name.trim());
  if (filled.length > 60) e.ingredients = "Не больше 60 ингредиентов.";
  const rows: Record<number, string> = {};
  for (const r of f.rows) {
    const a = parseAmount(r.amount);
    if (a !== null && (Number.isNaN(a) || a < 0)) rows[r.key] = "Количество: число, дробь (1/2) или пусто.";
    else if (!r.name.trim() && (r.amount.trim() || r.note.trim())) rows[r.key] = "Укажите название ингредиента.";
  }
  if (Object.keys(rows).length) e.rows = rows;
  return e;
}

function toInput(f: FormState, isEdit: boolean): RecipeInput {
  const opt = (s: string) => (s.trim() ? s.trim() : null);
  return {
    title: f.title.trim(),
    kind: f.kind,
    description: f.description.trim(),
    instructions: f.instructions,
    imageUrl: opt(f.imageUrl),
    servings: parseAmount(f.servings) ?? 1,
    glass: opt(f.glass),
    garnish: opt(f.garnish),
    method: opt(f.method),
    tags: f.tags,
    favorite: f.favorite,
    ingredients: f.rows
      .filter((r) => r.name.trim())
      .map((r) => ({ name: r.name.trim(), amount: parseAmount(r.amount), unit: r.unit.trim(), note: r.note.trim() })),
    ...(isEdit ? { versionNote: f.versionNote.trim() } : {}),
  };
}

function normalizeTag(t: string): string {
  return t.trim().toLowerCase().replace(/^#/, "").slice(0, 40);
}

function TagsInput({ tags, onChange, error }: { tags: string[]; onChange: (t: string[]) => void; error?: string }) {
  const [draft, setDraft] = useState("");
  const known = useTags();
  const listId = useId();
  const add = (raw: string) => {
    const parts = raw.split(",").map(normalizeTag).filter(Boolean);
    if (parts.length === 0) return;
    onChange([...new Set([...tags, ...parts])].slice(0, 30));
    setDraft("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && !draft && tags.length) {
      onChange(tags.slice(0, -1));
    }
  };
  return (
    <div className="field">
      <span className="field-label" id={`${listId}-label`}>
        Теги
      </span>
      <div className="tags-input">
        <ul className="tags-input__list" aria-label="Выбранные теги">
          {tags.map((t) => (
            <li key={t} className="tags-input__tag">
              #{t}
              <button type="button" onClick={() => onChange(tags.filter((x) => x !== t))} aria-label={`Убрать тег ${t}`}>
                <Icon name="close" />
              </button>
            </li>
          ))}
        </ul>
        <input
          className="tags-input__field"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => add(draft)}
          list={listId}
          placeholder={tags.length ? "ещё тег…" : "цитрусовый, классика…"}
          aria-labelledby={`${listId}-label`}
          aria-describedby={`${listId}-hint`}
        />
        <datalist id={listId}>
          {(known.data ?? []).map((t) => (
            <option key={t.tag} value={t.tag} />
          ))}
        </datalist>
      </div>
      <span id={`${listId}-hint`} className="field-hint">
        Enter или запятая — добавить тег.
      </span>
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

function EditorForm({ recipe }: { recipe: LocalRecipe | null }) {
  const isEdit = recipe !== null;
  const [f, setF] = useState<FormState>(() => initialState(recipe));
  const [initial] = useState(() => snapshot(f));
  const dirty = snapshot(f) !== initial;
  const { blocker, release } = useUnsavedGuard(dirty);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const unitListId = useId();
  const methodListId = useId();

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }));
  const setRow = (key: number, patch: Partial<Row>) =>
    setF((p) => ({ ...p, rows: p.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  const moveRow = (idx: number, dir: -1 | 1) =>
    setF((p) => {
      const rows = [...p.rows];
      const j = idx + dir;
      if (j < 0 || j >= rows.length) return p;
      [rows[idx], rows[j]] = [rows[j]!, rows[idx]!];
      return { ...p, rows };
    });

  async function upload(file: File) {
    if (file.size > 8 * 1024 * 1024) {
      toastError("Файл больше 8 МБ.");
      return;
    }
    setUploading(true);
    try {
      const { url } = await api.upload(file);
      set("imageUrl", url);
      toastSuccess("Фото загружено.");
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs = validate(f);
    setErrors(errs);
    if (Object.keys(errs).length) {
      toastError("Проверьте отмеченные поля.");
      requestAnimationFrame(() => document.querySelector<HTMLElement>("[aria-invalid='true']")?.focus());
      return;
    }
    setSaving(true);
    try {
      const input = toInput(f, isEdit);
      const saved = isEdit ? await api.updateRecipe(recipe.id, input) : await api.createRecipe(input);
      qc.setQueryData(keys.recipe(saved.id), saved);
      qc.invalidateQueries({ queryKey: keys.recipesAll });
      qc.invalidateQueries({ queryKey: keys.availableAll });
      qc.invalidateQueries({ queryKey: keys.pantrySuggestionsAll });
      qc.invalidateQueries({ queryKey: keys.tags });
      qc.invalidateQueries({ queryKey: keys.stats });
      // menus embed recipe summaries (title, photo, ingredients)
      if (isEdit) qc.invalidateQueries({ queryKey: keys.menus });
      if (isEdit) qc.invalidateQueries({ queryKey: keys.versions(saved.id) });
      toastSuccess(isEdit ? "Сохранено. Прежний вариант — в истории." : "Рецепт добавлен.");
      release();
      navigate(`/recipes/${saved.id}`);
    } catch (err) {
      toastError(errorMessage(err));
      setSaving(false);
    }
  }

  const rowsErr = errors.rows ?? {};
  return (
    <form className="editor" onSubmit={submit} noValidate>
      <header className="page-head editor__head">
        <div>
          <p className="eyebrow">{isEdit ? "Редактирование" : "Новый рецепт"}</p>
          <h1 className="serif">{isEdit ? recipe.title : "Новый рецепт"}</h1>
        </div>
      </header>
      <div className="editor__card panel">

      <section className="editor__grid" aria-label="Основное">
        <label className="field editor__title">
          <span>Название *</span>
          <input
            className="input input--title"
            value={f.title}
            onChange={(e) => set("title", e.target.value)}
            maxLength={200}
            required
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={errors.title ? "err-title" : undefined}
          />
          {errors.title && (
            <span id="err-title" className="field-error">
              {errors.title}
            </span>
          )}
        </label>

        <fieldset className="field editor__kind">
          <legend className="field-label">Тип</legend>
          <div className="segmented">
            {KINDS.map((k) => (
              <label key={k.value} className="segmented__opt">
                <input type="radio" name="kind" value={k.value} checked={f.kind === k.value} onChange={() => set("kind", k.value)} />
                <span>{k.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="field editor__wide">
          <span>Короткое описание</span>
          <textarea
            className="textarea"
            rows={2}
            style={{ minHeight: 70 }}
            value={f.description}
            onChange={(e) => set("description", e.target.value)}
            maxLength={2000}
            aria-invalid={errors.description ? true : undefined}
          />
          {errors.description && <span className="field-error">{errors.description}</span>}
        </label>

        <label className="field">
          <span>Порций</span>
          <input
            className="input"
            inputMode="decimal"
            value={f.servings}
            onChange={(e) => set("servings", e.target.value)}
            aria-invalid={errors.servings ? true : undefined}
            aria-describedby={errors.servings ? "err-serv" : undefined}
          />
          {errors.servings && (
            <span id="err-serv" className="field-error">
              {errors.servings}
            </span>
          )}
        </label>
        <label className="field">
          <span>Бокал</span>
          <input className="input" value={f.glass} onChange={(e) => set("glass", e.target.value)} placeholder="Купе, рокс…" />
        </label>
        <label className="field">
          <span>Метод</span>
          <input className="input" value={f.method} onChange={(e) => set("method", e.target.value)} list={methodListId} placeholder="shake, stir…" />
          <datalist id={methodListId}>
            {METHODS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>Гарнир</span>
          <input className="input" value={f.garnish} onChange={(e) => set("garnish", e.target.value)} placeholder="Цедра апельсина" />
        </label>
      </section>

      <section className="editor__section" aria-labelledby="ed-ings">
        <h2 id="ed-ings" className="editor__h2">
          Ингредиенты
        </h2>
        <datalist id={unitListId}>
          {UNITS.filter(Boolean).map((u) => (
            <option key={u} value={u} />
          ))}
        </datalist>
        <ol className="ing-rows">
          {f.rows.map((r, i) => (
            <li key={r.key} className="ing-row">
              <span className="ing-row__n" aria-hidden="true">
                {i + 1}
              </span>
              <label className="field ing-row__name">
                <span className="visually-hidden">Ингредиент {i + 1}</span>
                <input
                  className="input"
                  value={r.name}
                  onChange={(e) => setRow(r.key, { name: e.target.value })}
                  placeholder="Джин"
                  aria-invalid={rowsErr[r.key] ? true : undefined}
                />
              </label>
              <label className="field ing-row__amount">
                <span className="visually-hidden">Количество</span>
                <input
                  className="input tabular"
                  inputMode="decimal"
                  value={r.amount}
                  onChange={(e) => setRow(r.key, { amount: e.target.value })}
                  placeholder="45"
                  aria-invalid={rowsErr[r.key] ? true : undefined}
                />
              </label>
              <label className="field ing-row__unit">
                <span className="visually-hidden">Единица</span>
                <input className="input tabular" value={r.unit} onChange={(e) => setRow(r.key, { unit: e.target.value })} list={unitListId} placeholder="ml" />
              </label>
              <label className="field ing-row__note">
                <span className="visually-hidden">Заметка</span>
                <input className="input" value={r.note} onChange={(e) => setRow(r.key, { note: e.target.value })} placeholder="Заметка" />
              </label>
              <div className="ing-row__tools">
                <IconButton icon="up" look="plain" label={`Поднять ингредиент ${i + 1}`} onClick={() => moveRow(i, -1)} disabled={i === 0} />
                <IconButton icon="down" look="plain" label={`Опустить ингредиент ${i + 1}`} onClick={() => moveRow(i, 1)} disabled={i === f.rows.length - 1} />
                <IconButton
                  icon="trash"
                  look="plain"
                  tone="danger"
                  label={`Удалить ингредиент ${i + 1}`}
                  onClick={() => set("rows", f.rows.filter((x) => x.key !== r.key))}
                />
              </div>
              {rowsErr[r.key] && <span className="field-error ing-row__err">{rowsErr[r.key]}</span>}
            </li>
          ))}
        </ol>
        {errors.ingredients && <p className="field-error">{errors.ingredients}</p>}
        <div className="row editor__add">
          <Button icon="plus" onClick={() => set("rows", [...f.rows, newRow()])} disabled={f.rows.length >= 60}>
            Ещё ингредиент
          </Button>
          <p className="field-hint">Количество можно писать дробью: 1/2, 1 1/2, ¾. Пусто — «по вкусу».</p>
        </div>
      </section>

      <section className="editor__section" aria-labelledby="ed-method">
        <div className="row">
          <h2 id="ed-method" className="editor__h2">
            Приготовление
          </h2>
          <span className="spacer" />
          <div className="segmented" role="tablist" aria-label="Режим">
            <button type="button" role="tab" aria-selected={!preview} className="segmented__btn" onClick={() => setPreview(false)}>
              Текст
            </button>
            <button type="button" role="tab" aria-selected={preview} className="segmented__btn" onClick={() => setPreview(true)}>
              Предпросмотр
            </button>
          </div>
        </div>
        {preview ? (
          <div className="editor__preview">{f.instructions.trim() ? <Markdown source={f.instructions} /> : <p className="muted">Пока пусто.</p>}</div>
        ) : (
          <label className="field">
            <span className="visually-hidden">Инструкция (markdown)</span>
            <textarea
              className="textarea editor__md"
              value={f.instructions}
              onChange={(e) => set("instructions", e.target.value)}
              placeholder={"1. Охладите бокал.\n2. Смешайте всё со льдом…\n\n**Совет:** …"}
              aria-invalid={errors.instructions ? true : undefined}
            />
          </label>
        )}
        {errors.instructions && <p className="field-error">{errors.instructions}</p>}
      </section>

      <section className="editor__section editor__grid" aria-label="Фото и теги">
        <div className="field editor__wide">
          <span className="field-label">Фото</span>
          <div className="image-pick">
            <div className="image-pick__preview">
              <Img
                src={f.imageUrl.trim() || null}
                alt="Предпросмотр фото"
                glass={guessGlass({ kind: f.kind, glass: f.glass, title: f.title, ingredientNames: f.rows.map((r) => r.name) })}
                seed={recipe?.id ?? "new"}
                ratio="1 / 1"
                width={320}
                height={320}
              />
            </div>
            <div className="stack image-pick__controls" style={{ ["--stack-gap" as string]: "10px" }}>
              <label className="field">
                <span>Ссылка на изображение</span>
                <input className="input" type="url" inputMode="url" value={f.imageUrl} onChange={(e) => set("imageUrl", e.target.value)} placeholder="https://… или /uploads/…" />
              </label>
              <div className="row">
                <input
                  ref={fileRef}
                  id="ed-upload"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                  className="visually-hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void upload(file);
                  }}
                />
                <label htmlFor="ed-upload" className={buttonClass({}, "image-pick__upload")} aria-disabled={uploading}>
                  <Icon name="upload" />
                  <span className="btn__label">{uploading ? "Загружаю…" : "Загрузить файл"}</span>
                </label>
                {f.imageUrl && (
                  <Button variant="quiet" icon="close" onClick={() => set("imageUrl", "")}>
                    Убрать
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="editor__wide">
          <TagsInput tags={f.tags} onChange={(t) => set("tags", t)} error={errors.tags} />
        </div>
        <label className="check editor__wide">
          <input type="checkbox" checked={f.favorite} onChange={(e) => set("favorite", e.target.checked)} />
          <span>В избранное</span>
        </label>
      </section>

      </div>
      <footer className="editor__foot">
        {isEdit && (
          <label className="field editor__note">
            <span>Заметка к версии</span>
            <input
              className="input"
              value={f.versionNote}
              onChange={(e) => set("versionNote", e.target.value)}
              placeholder="например: меньше сиропа"
              maxLength={200}
            />
          </label>
        )}
        <div className="row">
          <Button type="submit" variant="primary" icon="check" disabled={saving}>
            {saving ? "Сохраняю…" : isEdit ? "Сохранить" : "Добавить рецепт"}
          </Button>
          <ButtonLink to={isEdit ? `/recipes/${recipe.id}` : "/recipes"}>Отмена</ButtonLink>
        </div>
      </footer>
      <ConfirmDialog
        open={blocker.state === "blocked"}
        title="Уйти без сохранения?"
        confirmLabel="Уйти, не сохраняя"
        danger
        onConfirm={() => blocker.proceed?.()}
        onClose={() => blocker.reset?.()}
      >
        <p>Есть несохранённые изменения — они пропадут.</p>
      </ConfirmDialog>
    </form>
  );
}

export default function RecipeEditor() {
  const { id } = useParams();
  const isHost = useIsHost();
  const recipeId = id ? Number(id) : null;
  const validId = recipeId !== null && Number.isInteger(recipeId) && recipeId > 0;
  const q = useRecipe(validId ? recipeId : 0);

  if (!isHost) {
    return (
      <div className="page page--narrow">
        <EmptyState
          title="Редактировать может только хозяин"
          action={
            <Button variant="primary" icon="key" onClick={requestLogin}>
              Войти
            </Button>
          }
        >
          Гости могут смотреть рецепты и заказывать из меню.
        </EmptyState>
      </div>
    );
  }

  if (recipeId === null) {
    return (
      <div className="page page--narrow">
        <EditorForm key="new" recipe={null} />
      </div>
    );
  }

  // "/recipes/abc/edit": the query is disabled and would stay pending forever
  if (!validId) {
    return (
      <div className="page page--narrow">
        <EmptyState title="Рецепт не найден" action={<ButtonLink to="/recipes">Все рецепты</ButtonLink>} />
      </div>
    );
  }

  return (
    <div className="page page--narrow">
      {q.isPending ? (
        <div className="editor" aria-busy="true">
          <LoadingNote />
          <Skeleton h={40} w="50%" />
          <Skeleton h={360} r={16} className="sk-gap" />
        </div>
      ) : q.isError ? (
        isApiError(q.error, 404) ? (
          <EmptyState title="Рецепт не найден" action={<ButtonLink to="/recipes">Все рецепты</ButtonLink>} />
        ) : (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        )
      ) : (
        <EditorForm key={q.data.id} recipe={q.data} />
      )}
    </div>
  );
}
