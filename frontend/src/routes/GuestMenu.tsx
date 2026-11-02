import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, isApiError } from "../api/client";
import { DEFAULT_SETTINGS, keys, useActiveMenu, useAvailable, useAvailableCount, useSettings } from "../api/queries";
import type { Kind, Menu, MenuItem, MissingIngredient, Order, OrderStatus, RecipeSummary } from "../api/types";
import { Button, ButtonLink } from "../components/Button";
import { LoadMore } from "../components/LoadMore";
import { useDebounced } from "../hooks/useDebounced";
import { missingLine, normalizeName } from "../lib/pantry";
import { Dialog } from "../components/Dialog";
import { Icon } from "../components/Icon";
import { Img } from "../components/Img";
import { IngredientList } from "../components/recipe/IngredientList";
import { EmptyState, ErrorState, LoadingNote, Skeleton } from "../components/States";
import { useIsHost } from "../lib/auth";
import { formatTime } from "../lib/format";
import { addMyOrder, forgetOrder, markFinished, pruneMyOrders, useMyOrders } from "../lib/myOrders";
import { getGuestName, setGuestName, useUnitSystem } from "../lib/prefs";
import { guessGlass } from "../lib/glass";
import { toast, toastError, toastSuccess } from "../lib/toast";
import "./menu.css";

const STATUS_LABEL: Record<OrderStatus, string> = {
  new: "Принят",
  making: "Готовится",
  done: "Готово",
  cancelled: "Отменён",
};

/** What the guest tapped: a curated menu item (has menuId) or a row from «Можно приготовить». */
interface Pick {
  recipe: RecipeSummary;
  note?: string;
  menuId?: number;
  missing?: MissingIngredient[];
}

function OrderSheet({ item, onClose }: { item: Pick | null; onClose: () => void }) {
  const [system] = useUnitSystem();
  const [name, setName] = useState(getGuestName);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const recipeQ = useQuery({
    queryKey: keys.recipe(item?.recipe.id ?? 0),
    queryFn: ({ signal }) => api.recipe(item?.recipe.id ?? 0, signal),
    enabled: !!item,
  });

  async function order(e: FormEvent) {
    e.preventDefault();
    if (!item) return;
    const guestName = name.trim();
    if (!guestName) {
      setError("Как вас зовут? Так хозяин поймёт, кому нести.");
      return;
    }
    if (guestName.length > 60) {
      setError("Имя — не длиннее 60 символов.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const o = await api.createOrder({ recipeId: item.recipe.id, menuId: item.menuId, guestName, note: note.trim() || undefined });
      setGuestName(guestName);
      addMyOrder(o.id);
      qc.setQueryData(keys.order(o.id), o);
      qc.invalidateQueries({ queryKey: keys.stats });
      setNote("");
      toastSuccess(`Заказ принят: ${o.recipeTitle}. Статус — внизу экрана.`);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      // 400 here usually means the host changed the menu meanwhile: show the current board
      if (isApiError(err, 400) || isApiError(err, 404)) {
        qc.invalidateQueries({ queryKey: keys.activeMenu });
        qc.invalidateQueries({ queryKey: keys.availableAll });
      }
    } finally {
      setBusy(false);
    }
  }

  const r = item?.recipe;
  return (
    <Dialog open={!!item} onClose={onClose} title={r?.title ?? ""} variant="sheet">
      {item && r && (
        <div className="order-sheet">
          <div className="order-sheet__top">
            <div className="order-sheet__img">
              <Img src={r.imageUrl} alt="" glass={guessGlass({ kind: r.kind, title: r.title, ingredientNames: r.ingredientNames })} seed={r.id} ratio="1 / 1" thumb />
            </div>
            <div>
              {r.description && <p className="order-sheet__desc">{r.description}</p>}
              {item.note && <p className="order-sheet__note">{item.note}</p>}
              {item.missing && item.missing.length > 0 && (
                <p className="order-sheet__miss">Сейчас {missingLine(item.missing)} — хозяин подскажет замену.</p>
              )}
            </div>
          </div>
          <section aria-label="Состав" className="order-sheet__ings">
            {recipeQ.isPending ? (
              <div className="stack" style={{ ["--stack-gap" as string]: "8px" }} aria-busy="true">
                <Skeleton h={18} />
                <Skeleton h={18} w="80%" />
                <Skeleton h={18} w="60%" />
              </div>
            ) : recipeQ.isError ? (
              <p className="muted">{r.ingredientNames.join(" · ")}</p>
            ) : (
              <IngredientList ingredients={recipeQ.data.ingredients} factor={1} system={system} />
            )}
          </section>
          <form className="order-form" onSubmit={order} noValidate>
            <label className="field">
              <span>Ваше имя</span>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="given-name"
                maxLength={60}
                enterKeyHint="send"
                aria-invalid={error && !name.trim() ? true : undefined}
              />
            </label>
            <label className="field">
              <span>Пожелание (необязательно)</span>
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="поменьше льда…" />
            </label>
            {error && (
              <p className="field-error" role="alert" style={{ margin: 0 }}>
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" size="lg" block icon="glass" disabled={busy}>
              {busy ? "Отправляю…" : "Заказать"}
            </Button>
          </form>
        </div>
      )}
    </Dialog>
  );
}

function MyOrders() {
  const refs = useMyOrders();
  const [open, setOpen] = useState(false);
  const seen = useRef(new Map<number, OrderStatus>());
  const results = useQueries({
    queries: refs.map((ref) => ({
      queryKey: keys.order(ref.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.order(ref.id, signal),
      refetchInterval: (q: { state: { data?: Order } }) => {
        const s = q.state.data?.status;
        return s === "done" || s === "cancelled" ? false : 5000;
      },
      refetchIntervalInBackground: false,
      retry: (n: number, e: unknown) => !isApiError(e, 404) && n < 2,
    })),
  });

  // react to status changes: remember finish time, toast "ready", forget deleted orders
  const statusKey = results.map((r, i) => `${refs[i]?.id}:${r.data?.status ?? (isApiError(r.error, 404) ? "gone" : "")}`).join("|");
  useEffect(() => {
    results.forEach((r, i) => {
      const ref = refs[i];
      if (!ref) return;
      if (isApiError(r.error, 404)) {
        forgetOrder(ref.id);
        return;
      }
      const o = r.data;
      if (!o) return;
      const prev = seen.current.get(o.id);
      if (prev && prev !== o.status) {
        if (o.status === "done") {
          toastSuccess(`${o.recipeTitle} — готово! Забирайте у стойки.`);
          navigator.vibrate?.(180);
        } else if (o.status === "making") toast(`${o.recipeTitle} уже готовится.`);
        else if (o.status === "cancelled") toastError(`${o.recipeTitle}: заказ отменён.`);
      }
      seen.current.set(o.id, o.status);
      if (o.status === "done" || o.status === "cancelled") markFinished(o.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- statusKey captures what matters
  }, [statusKey]);

  useEffect(() => {
    const t = window.setInterval(pruneMyOrders, 60_000);
    return () => window.clearInterval(t);
  }, []);

  if (refs.length === 0) return null;
  const orders = results.map((r) => r.data).filter((o): o is Order => !!o);
  const pending = orders.filter((o) => o.status === "new" || o.status === "making").length;
  const ready = orders.filter((o) => o.status === "done").length;

  return (
    <aside className={`pocket ${open ? "pocket--open" : ""}`} aria-label="Мои заказы">
      <button type="button" className="pocket__tab" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls="pocket-list">
        <Icon name="bell" />
        <span>Мои заказы</span>
        <span className="pocket__counts" aria-live="polite">
          {pending > 0 && <span className="pill pill--making">{pending} в работе</span>}
          {ready > 0 && <span className="pill pill--done">{ready} готово</span>}
        </span>
        <Icon name={open ? "down" : "up"} />
      </button>
      <ul id="pocket-list" className="pocket__list" hidden={!open}>
        {refs
          .slice()
          .reverse()
          .map((ref) => {
            const r = results[refs.indexOf(ref)];
            const o = r?.data;
            return (
              <li key={ref.id} className={`pocket__item ${o ? `is-${o.status}` : ""}`}>
                {o ? (
                  <>
                    <span className="pocket__title">{o.recipeTitle}</span>
                    <span className="pocket__meta">
                      {o.guestName} · {formatTime(o.createdAt)}
                    </span>
                    <span className={`pill pill--${o.status}`}>{STATUS_LABEL[o.status]}</span>
                  </>
                ) : r?.isError ? (
                  <span className="muted">Не удалось узнать статус заказа № {ref.id}</span>
                ) : (
                  <Skeleton h={20} />
                )}
              </li>
            );
          })}
      </ul>
    </aside>
  );
}

type TabKind = "cocktail" | "dish";
const tabOf = (k: Kind): TabKind => (k === "dish" ? "dish" : "cocktail");
const PAGE = 30;

function matches(r: RecipeSummary, q: string): boolean {
  if (!q) return true;
  const n = normalizeName(q);
  return normalizeName(r.title).includes(n) || r.ingredientNames.some((i) => normalizeName(i).includes(n));
}

function MenuRow({ pick, onPick, eager }: { pick: Pick; onPick: (p: Pick) => void; eager?: boolean }) {
  const r = pick.recipe;
  const miss = pick.missing && pick.missing.length > 0 ? missingLine(pick.missing) : "";
  return (
    <li className="menu-list__item">
      <button type="button" className="menu-row" onClick={() => onPick(pick)}>
        <span className="menu-row__img" aria-hidden="true">
          <Img
            src={r.imageUrl}
            alt=""
            glass={guessGlass({ kind: r.kind, title: r.title, ingredientNames: r.ingredientNames })}
            seed={r.id}
            ratio="1 / 1"
            thumb
            eager={eager}
            width={160}
            height={160}
          />
        </span>
        <span className="menu-row__text">
          <span className="menu-row__title">{r.title}</span>
          <span className="menu-row__sub">{pick.note || r.ingredientNames.slice(0, 4).join(" · ")}</span>
          {miss && <span className="menu-row__miss">{miss}</span>}
        </span>
        <Icon name="chevronRight" className="menu-row__go" />
      </button>
    </li>
  );
}

function Curated({ menu, items, onPick }: { menu: Menu; items: MenuItem[]; onPick: (p: Pick) => void }) {
  return (
    <section className="guest-sec" aria-labelledby="curated-title">
      <header className="guest-sec__head">
        <h2 id="curated-title" className="guest-sec__title">
          Рекомендую сегодня
        </h2>
        <p className="guest-sec__sub">
          {menu.title}
          {menu.description && <span className="guest-sec__desc"> — {menu.description}</span>}
        </p>
      </header>
      <ul className="menu-list">
        {items.map((it, i) => (
          <MenuRow key={it.recipeId} eager={i < 4} pick={{ recipe: it.recipe, note: it.note, menuId: menu.id, missing: it.missing }} onPick={onPick} />
        ))}
      </ul>
    </section>
  );
}

function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="menu-list menu-list--sk" aria-busy="true">
      <LoadingNote text="Загружаю меню…" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="menu-sk">
          <Skeleton w={64} h={64} r={12} />
          <div style={{ flex: 1 }}>
            <Skeleton h={16} w="55%" />
            <Skeleton h={12} w="75%" className="sk-gap-s" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function GuestMenu() {
  const isHost = useIsHost();
  const [sp, setSp] = useSearchParams();
  const kind: TabKind = sp.get("k") === "dish" ? "dish" : "cocktail";
  const setKind = (k: TabKind) =>
    setSp(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (k === "cocktail") next.delete("k");
        else next.set("k", k);
        return next;
      },
      { replace: true },
    );
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 250);
  const [picked, setPicked] = useState<Pick | null>(null);

  const settingsQ = useSettings();
  // settings are public; if they fail, fall back to the safe defaults instead of blocking the menu
  const settings = settingsQ.data ?? DEFAULT_SETTINGS;
  const ready = !settingsQ.isPending;
  const maxMissing = settings.guestMaxMissing;

  const menuQ = useActiveMenu();
  const counts = {
    cocktail: useAvailableCount({ kind: "cocktail", maxMissing }, ready).data,
    dish: useAvailableCount({ kind: "dish", maxMissing }, ready).data,
  };
  const list = useAvailable({ kind, maxMissing, q: q || undefined }, PAGE, ready);

  const menu = settings.guestShowMenu ? (menuQ.data ?? null) : null;
  const curated = menu ? menu.items.filter((it) => tabOf(it.recipe.kind) === kind && (it.missing?.length ?? 0) <= maxMissing && matches(it.recipe, q)) : [];
  const curatedIds = new Set(curated.map((it) => it.recipeId));
  const rows = (list.data?.pages.flatMap((p) => p.items) ?? []).filter((a) => !curatedIds.has(a.recipe.id));
  const total = list.data?.pages[0]?.total;

  const loading = !ready || list.isPending || (settings.guestShowMenu && menuQ.isPending);
  const nothing = !loading && curated.length === 0 && rows.length === 0 && !list.isError;

  return (
    <div className="page page--narrow guest-menu">
      <header className="guest-head">
        <p className="eyebrow">Меню на сегодня</p>
        <h1 className="serif guest-head__title">Что приготовить?</h1>
        <p className="guest-head__lead">Выберите, что хочется, — хозяин приготовит. Здесь только то, что есть дома прямо сейчас.</p>
        {isHost && (
          <p className="guest-head__host">
            <Icon name="info" /> Так меню видят гости. <Link to="/pantry">Продукты и настройки</Link>
          </p>
        )}
      </header>

      <div className="guest-tabs">
        <div className="segmented segmented--fill segmented--lg" role="group" aria-label="Раздел меню">
          {(["cocktail", "dish"] as const).map((k) => (
            <button key={k} type="button" className="segmented__btn" aria-pressed={kind === k} onClick={() => setKind(k)}>
              {k === "cocktail" ? "Коктейли" : "Блюда"}
              {counts[k] !== undefined && <span className="segmented__count">{counts[k]}</span>}
            </button>
          ))}
        </div>
      </div>

      <label className="search guest-search">
        <span className="visually-hidden">Поиск по меню</span>
        <Icon name="search" />
        <input type="search" placeholder={kind === "cocktail" ? "Найти коктейль или ингредиент" : "Найти блюдо или продукт"} value={search} onChange={(e) => setSearch(e.target.value)} enterKeyHint="search" />
      </label>

      {loading ? (
        <ListSkeleton />
      ) : nothing ? (
        q ? (
          <EmptyState art="search" title="Ничего не нашлось" action={<Button onClick={() => setSearch("")}>Очистить поиск</Button>}>
            Попробуйте другое название или ингредиент.
          </EmptyState>
        ) : (
          <EmptyState
            title={kind === "cocktail" ? "Коктейлей сейчас нет" : "Блюд сейчас нет"}
            action={
              isHost ? (
                <ButtonLink to="/pantry" variant="primary" icon="plus">
                  Отметить продукты
                </ButtonLink>
              ) : kind === "cocktail" && counts.dish ? (
                <Button onClick={() => setKind("dish")}>Посмотреть блюда</Button>
              ) : kind === "dish" && counts.cocktail ? (
                <Button onClick={() => setKind("cocktail")}>Посмотреть коктейли</Button>
              ) : undefined
            }
          >
            {isHost ? "Отметьте, какие продукты есть дома, — и здесь появится всё, что из них получится." : "Хозяин скоро пополнит запасы. Загляните чуть позже."}
          </EmptyState>
        )
      ) : (
        <>
          {menu && curated.length > 0 && <Curated menu={menu} items={curated} onPick={setPicked} />}
          {list.isError ? (
            <ErrorState error={list.error} onRetry={() => list.refetch()} title="Список не загрузился" />
          ) : (
            rows.length > 0 && (
              <section className="guest-sec" aria-labelledby="avail-title">
                <header className="guest-sec__head">
                  <h2 id="avail-title" className="guest-sec__title">
                    {curated.length > 0 ? "Ещё можно приготовить" : "Можно приготовить"}
                    {total !== undefined && <span className="guest-sec__count">{Math.max(rows.length, total - curated.length)}</span>}
                  </h2>
                </header>
                <ul className={`menu-list ${list.isPlaceholderData ? "is-stale" : ""}`}>
                  {rows.map((a, i) => (
                    <MenuRow key={a.recipe.id} eager={i < 4} pick={{ recipe: a.recipe, missing: a.missing }} onPick={setPicked} />
                  ))}
                </ul>
                <LoadMore hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onMore={() => void list.fetchNextPage()} />
              </section>
            )
          )}
          <p className="board__hint">Нажмите на позицию, чтобы заказать.</p>
        </>
      )}
      <OrderSheet item={picked} onClose={() => setPicked(null)} />
      <MyOrders />
    </div>
  );
}
