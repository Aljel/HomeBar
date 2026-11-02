import { useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../api/client";
import {
  DEFAULT_SETTINGS,
  keys,
  useAvailable,
  useAvailableCount,
  usePantry,
  usePantrySuggestions,
  useSettings,
} from "../api/queries";
import type { Availability, DiscoverKind, PantryItem, Settings } from "../api/types";
import { Button, ButtonLink, IconButton } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Icon } from "../components/Icon";
import { Img } from "../components/Img";
import { LoadMore } from "../components/LoadMore";
import { MissingChips } from "../components/MissingChips";
import { EmptyState, ErrorState, LoadingNote, Skeleton } from "../components/States";
import { usePantryActions } from "../hooks/usePantryActions";
import { useIsHost } from "../lib/auth";
import { plural } from "../lib/format";
import { guessGlass } from "../lib/glass";
import { loginRequest } from "../lib/loginRequest";
import { QUICK_SETS, groupByCategory, groupByMissing, missingFromSet, productCount, recipeCount } from "../lib/pantry";
import { toastError, toastSuccess } from "../lib/toast";
import { LibraryCard } from "./pantry/LibraryCard";
import { PantryInput } from "./pantry/PantryInput";
import "./pantry.css";

type Actions = ReturnType<typeof usePantryActions>;

const KIND_TABS: { value: DiscoverKind; label: string }[] = [
  { value: "cocktail", label: "Коктейли" },
  { value: "dish", label: "Блюда" },
];

/** How many missing ingredients the host's own list goes down to. */
const HOST_MAX_MISSING = 3;

function KindTabs({ value, onChange, counts, label }: { value: DiscoverKind; onChange: (k: DiscoverKind) => void; counts?: Partial<Record<DiscoverKind, number>>; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {KIND_TABS.map((t) => (
        <button key={t.value} type="button" className="segmented__btn" aria-pressed={value === t.value} onClick={() => onChange(t.value)}>
          {t.label}
          {counts?.[t.value] !== undefined && <span className="segmented__count">{counts[t.value]}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------- the shelf: what the host has ----------

function Shelf({ items, actions }: { items: PantryItem[]; actions: Actions }) {
  const groups = groupByCategory(items);
  return (
    <div className="shelf">
      {groups.map((g) => (
        <section key={g.category} className="shelf__group" aria-label={g.label}>
          <h3 className="shelf__title">
            {g.label} <span className="shelf__count">{g.items.length}</span>
          </h3>
          <ul className="pchips">
            {g.items.map((p) => (
              <li key={p.key} className="pchip">
                <span className="pchip__name" title={p.nameEn !== p.name ? p.nameEn : undefined}>
                  {p.name}
                </span>
                <button type="button" className="pchip__x" aria-label={`Убрать: ${p.name}`} onClick={() => void actions.remove(p)}>
                  <Icon name="close" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function QuickSets({ items, actions }: { items: PantryItem[]; actions: Actions }) {
  async function addSet(names: string[], label: string) {
    if (names.length === 0) {
      toastSuccess(`«${label}» — всё уже есть.`);
      return;
    }
    const res = await actions.add(names);
    if (res) toastSuccess(res.added.length ? `Добавлено ${productCount(res.added.length)} из набора «${label}».` : `«${label}» — всё уже есть.`);
  }
  return (
    <div className="quick" role="group" aria-label="Быстро добавить набор">
      <span className="quick__label">Наборы:</span>
      {QUICK_SETS.map((s) => {
        const missing = missingFromSet(s, items);
        return (
          <Button key={s.id} icon={missing.length ? "plus" : "check"} className="quick__btn" disabled={actions.busy} onClick={() => void addSet(missing, s.label)} title={s.names.join(", ")}>
            {s.label}
          </Button>
        );
      })}
    </div>
  );
}

function ClearAll({ actions, count }: { actions: Actions; count: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="quiet" icon="trash" className="shelf__clear" onClick={() => setOpen(true)}>
        Очистить всё
      </Button>
      <ConfirmDialog
        open={open}
        title="Очистить продукты?"
        confirmLabel="Очистить"
        danger
        busy={actions.busy}
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          if (await actions.clear()) {
            setOpen(false);
            toastSuccess("Список продуктов очищен.");
          }
        }}
      >
        <p>Уберём все {productCount(count)}. Гости увидят только то, что можно приготовить совсем без продуктов, — скорее всего, ничего.</p>
      </ConfirmDialog>
    </>
  );
}

// ---------- side: summary, shopping hints, settings ----------

function Summary({ onShow }: { onShow: (k: DiscoverKind) => void }) {
  const c = useAvailableCount({ kind: "cocktail", maxMissing: 0 });
  const d = useAvailableCount({ kind: "dish", maxMissing: 0 });
  const cell = (q: typeof c, kind: DiscoverKind, forms: readonly [string, string, string]) => (
    <button type="button" className="sum__cell" onClick={() => onShow(kind)}>
      <span className="sum__num">{q.data ?? (q.isError ? "—" : "…")}</span>
      <span className="sum__label">{q.data !== undefined ? plural(q.data, forms) : forms[2]}</span>
    </button>
  );
  return (
    <section className="pcard sum" aria-labelledby="sum-title">
      <h2 id="sum-title" className="pcard__title">
        Можно приготовить сейчас
      </h2>
      <div className="sum__grid">
        {cell(c, "cocktail", ["коктейль", "коктейля", "коктейлей"])}
        {cell(d, "dish", ["блюдо", "блюда", "блюд"])}
      </div>
      <ButtonLink to="/menu" iconEnd="arrowRight" variant="quiet" className="sum__link">
        Как это видят гости
      </ButtonLink>
    </section>
  );
}

function Shopping({ actions }: { actions: Actions }) {
  const [kind, setKind] = useState<DiscoverKind>("cocktail");
  const q = usePantrySuggestions(kind);
  return (
    <section className="pcard buy" aria-labelledby="buy-title">
      <div className="buy__head">
        <h2 id="buy-title" className="pcard__title">
          Что докупить
        </h2>
        <KindTabs value={kind} onChange={setKind} label="Подсказки для" />
      </div>
      {q.isPending ? (
        <div className="stack" style={{ ["--stack-gap" as string]: "10px", width: "100%" }}>
          <Skeleton h={18} />
          <Skeleton h={18} w="80%" />
          <Skeleton h={18} w="70%" />
        </div>
      ) : q.isError ? (
        <p className="muted small">{errorMessage(q.error)}</p>
      ) : q.data.length === 0 ? (
        <p className="muted small">Пока нечего подсказать: ни один продукт в одиночку не открывает новых рецептов.</p>
      ) : (
        <ul className="buy__list">
          {q.data.map((s) => (
            <li key={s.key} className="buy__row">
              <span className="buy__name">{s.name}</span>
              <span className="buy__unlocks">откроет {recipeCount(s.unlocks)}</span>
              <IconButton icon="plus" label={`У меня есть: ${s.name}`} title="Уже есть дома — добавить" disabled={actions.busy} onClick={() => void actions.add([s.name])} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const MISSING_OPTIONS = [
  { value: 0, label: "Всё есть", hint: "Гости видят только то, что можно приготовить прямо сейчас." },
  { value: 1, label: "−1 продукт", hint: "Плюс то, где не хватает одного продукта — с пометкой «нет: …»." },
  { value: 2, label: "−2 продукта", hint: "Плюс то, где не хватает одного-двух продуктов — с пометкой «нет: …»." },
] as const;

function GuestSettings() {
  const qc = useQueryClient();
  const q = useSettings();
  const s = q.data ?? DEFAULT_SETTINGS;

  async function save(next: Settings) {
    const prev = q.data;
    qc.setQueryData(keys.settings, next);
    try {
      qc.setQueryData(keys.settings, await api.saveSettings(next));
    } catch (e) {
      qc.setQueryData(keys.settings, prev);
      toastError(errorMessage(e));
    }
  }

  const current = MISSING_OPTIONS.find((o) => o.value === s.guestMaxMissing);
  return (
    <section className="pcard guest-set" aria-labelledby="guest-set-title">
      <h2 id="guest-set-title" className="pcard__title">
        Меню для гостей
      </h2>
      <fieldset className="guest-set__field" disabled={q.isPending}>
        <legend className="field-label">Гостям показывать</legend>
        <div className="segmented segmented--fill" role="radiogroup" aria-label="Гостям показывать">
          {MISSING_OPTIONS.map((o) => (
            <label key={o.value} className="segmented__opt">
              <input type="radio" name="guestMaxMissing" checked={s.guestMaxMissing === o.value} onChange={() => void save({ ...s, guestMaxMissing: o.value })} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
        <p className="field-hint">{current?.hint ?? `Допускается ${s.guestMaxMissing} недостающих продукта.`}</p>
      </fieldset>
      <label className="switch">
        <input type="checkbox" role="switch" checked={s.guestShowMenu} disabled={q.isPending} onChange={(e) => void save({ ...s, guestShowMenu: e.target.checked })} />
        <span>
          Показывать мою подборку-меню
          <span className="field-hint guest-set__sub">Активное меню со «Стойки» — первым блоком «Рекомендую сегодня».</span>
        </span>
      </label>
    </section>
  );
}

// ---------- what can be made ----------

function AvailRow({ a, actions }: { a: Availability; actions: Actions }) {
  const r = a.recipe;
  return (
    <li className="avail__row">
      <Link to={`/recipes/${r.id}`} className="avail__img" tabIndex={-1} aria-hidden="true">
        <Img src={r.imageUrl} alt="" thumb glass={guessGlass({ kind: r.kind, title: r.title, ingredientNames: r.ingredientNames })} seed={r.id} ratio="1 / 1" width={96} height={96} />
      </Link>
      <div className="avail__text">
        <Link to={`/recipes/${r.id}`} className="avail__title">
          {r.title}
          {r.favorite && (
            <>
              <Icon name="heart" filled className="avail__fav" />
              <span className="visually-hidden">(в избранном)</span>
            </>
          )}
        </Link>
        {a.missing.length > 0 ? <MissingChips missing={a.missing} onAdd={(m) => void actions.add([m.name])} disabled={actions.busy} /> : <span className="avail__ok">{r.ingredientNames.slice(0, 4).join(" · ")}</span>}
      </div>
    </li>
  );
}

function CanMake({ kind, setKind, actions }: { kind: DiscoverKind; setKind: (k: DiscoverKind) => void; actions: Actions }) {
  const q = useAvailable({ kind, maxMissing: HOST_MAX_MISSING }, 30);
  const c = useAvailableCount({ kind: "cocktail", maxMissing: HOST_MAX_MISSING });
  const d = useAvailableCount({ kind: "dish", maxMissing: HOST_MAX_MISSING });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const groups = groupByMissing(items);

  return (
    <section id="can-make" className="panel can-make" aria-labelledby="can-make-title">
      <header className="can-make__head">
        <h2 id="can-make-title">Что можно приготовить</h2>
        <KindTabs value={kind} onChange={setKind} counts={{ cocktail: c.data, dish: d.data }} label="Показать" />
      </header>
      {q.isPending ? (
        <div className="stack" aria-busy="true">
          <LoadingNote text="Считаю, что можно приготовить…" />
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} h={52} />
          ))}
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : items.length === 0 ? (
        <p className="can-make__empty muted">
          {kind === "cocktail" ? "Коктейлей" : "Блюд"} даже с тремя недостающими продуктами пока нет. Добавьте продукты выше или загрузите библиотеку рецептов.
        </p>
      ) : (
        <div className={q.isPlaceholderData ? "is-stale" : undefined}>
          {groups.map((g) => (
            <section key={g.missing} className="avail" aria-label={g.title}>
              <h3 className={`avail__group ${g.missing === 0 ? "avail__group--ok" : ""}`}>
                {g.missing === 0 && <Icon name="check" />}
                {g.title}
              </h3>
              <ul className="avail__list">
                {g.items.map((a) => (
                  <AvailRow key={a.recipe.id} a={a} actions={actions} />
                ))}
              </ul>
            </section>
          ))}
          <LoadMore hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onMore={() => void q.fetchNextPage()} />
        </div>
      )}
    </section>
  );
}

// ---------- page ----------

export default function Pantry() {
  const isHost = useIsHost();
  const pantry = usePantry(isHost);
  const actions = usePantryActions();
  const [kind, setKind] = useState<DiscoverKind>("cocktail");

  if (!isHost) {
    return (
      <div className="page page--narrow">
        <EmptyState
          title="Это страница хозяина"
          action={
            <Button variant="primary" icon="key" onClick={() => loginRequest.set(true)}>
              Войти как хозяин
            </Button>
          }
        >
          Здесь хозяин отмечает, какие продукты есть дома. Гостям — в <Link to="/menu">меню</Link>.
        </EmptyState>
      </div>
    );
  }

  const items = pantry.data ?? [];
  const showList = (k: DiscoverKind) => {
    setKind(k);
    document.getElementById("can-make")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  return (
    <div className="page pantry">
      <header className="page-head">
        <h1 className="serif">Продукты</h1>
        <p className="page-head__lead">Что есть дома. Гостям предлагаются только коктейли и блюда, которые из этого получатся.</p>
      </header>

      <div className="pantry__grid">
        <section className="panel pantry__main" aria-label="Мои продукты">
          <PantryInput onAdd={actions.add} busy={actions.busy} />
          <QuickSets items={items} actions={actions} />

          {pantry.isPending ? (
            <div className="shelf" aria-busy="true">
              <Skeleton h={14} w={120} />
              <div className="row" style={{ marginTop: 10 }}>
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} h={32} w={70 + ((i * 23) % 50)} r={999} />
                ))}
              </div>
            </div>
          ) : pantry.isError ? (
            <ErrorState error={pantry.error} onRetry={() => pantry.refetch()} title="Список продуктов не загрузился" />
          ) : items.length === 0 ? (
            <p className="shelf__empty">
              Пока пусто. Начните вводить продукт — например, «лайм» — и нажмите Enter, или вставьте целый список через запятую.
            </p>
          ) : (
            <>
              <div className="shelf__bar">
                <span className="shelf__total" aria-live="polite">
                  {productCount(items.length)}
                </span>
                <ClearAll actions={actions} count={items.length} />
              </div>
              <Shelf items={items} actions={actions} />
            </>
          )}
        </section>

        <div className="pantry__side">
          <Summary onShow={showList} />
          <Shopping actions={actions} />
          <GuestSettings />
          <LibraryCard />
        </div>

        <CanMake kind={kind} setKind={setKind} actions={actions} />
      </div>
    </div>
  );
}
