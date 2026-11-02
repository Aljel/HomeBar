import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../api/client";
import { keys } from "../api/queries";
import type { Order, OrderStatus } from "../api/types";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { EmptyState, ErrorState, LoadingNote, Skeleton } from "../components/States";
import { upsertActive, useOrderStream, type StreamMode } from "../hooks/useOrderStream";
import { useIsHost } from "../lib/auth";
import { chime, unlockAudio } from "../lib/chime";
import { formatTime, minutesAgo, plural } from "../lib/format";
import { requestLogin } from "../lib/loginRequest";
import { readString, writeString } from "../lib/storage";
import { toastError } from "../lib/toast";
import { MenuManager } from "./bar/MenuManager";
import "./bar.css";

const MODE_LABEL: Record<StreamMode, string> = {
  connecting: "Подключаюсь…",
  live: "Заказы приходят сразу",
  polling: "Обновляю каждые 5 секунд",
};

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

function OrderCard({ order, fresh, now }: { order: Order; fresh: boolean; now: number }) {
  const qc = useQueryClient();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!confirmCancel) return;
    const t = window.setTimeout(() => setConfirmCancel(false), 3500);
    return () => window.clearTimeout(t);
  }, [confirmCancel]);

  async function setStatus(status: OrderStatus) {
    setBusy(true);
    const prev = qc.getQueryData<Order[]>(keys.orders("active"));
    qc.setQueryData<Order[]>(keys.orders("active"), (old) => upsertActive(old, { ...order, status }));
    try {
      const o = await api.setOrderStatus(order.id, status);
      qc.setQueryData<Order[]>(keys.orders("active"), (old) => upsertActive(old, o));
      qc.invalidateQueries({ queryKey: keys.orders("all") });
    } catch (e) {
      qc.setQueryData(keys.orders("active"), prev);
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`ticket ticket--${order.status} ${fresh ? "ticket--fresh" : ""}`}>
      <div className="ticket__head">
        <span className="ticket__no">№ {order.id}</span>
        <time className="ticket__time" dateTime={order.createdAt} title={formatTime(order.createdAt)}>
          {minutesAgo(order.createdAt, now)}
        </time>
      </div>
      <h3 className="ticket__title">{order.recipeTitle}</h3>
      <p className="ticket__guest">
        <Icon name="user" /> {order.guestName}
      </p>
      {order.note && <p className="ticket__note">{order.note}</p>}
      <div className="ticket__actions">
        {order.status === "new" ? (
          <Button variant="primary" icon="glass" onClick={() => setStatus("making")} disabled={busy}>
            Готовлю
          </Button>
        ) : (
          <Button variant="primary" icon="check" onClick={() => setStatus("done")} disabled={busy}>
            Готово
          </Button>
        )}
        <Button
          variant={confirmCancel ? "danger" : "quiet"}
          onClick={() => (confirmCancel ? setStatus("cancelled") : setConfirmCancel(true))}
          disabled={busy}
        >
          {confirmCancel ? "Точно отменить?" : "Отменить"}
        </Button>
      </div>
    </li>
  );
}

function History() {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: keys.orders("all"),
    queryFn: ({ signal }) => api.orders("all", signal),
    enabled: open,
  });
  const done = (q.data ?? []).filter((o) => o.status === "done" || o.status === "cancelled").slice(0, 40);
  return (
    <details className="history" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="history__summary">
        <Icon name="history" /> Завершённые заказы
        <Icon name="down" className="history__chev" />
      </summary>
      {q.isPending && open ? (
        <Skeleton h={80} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : done.length === 0 ? (
        <p className="muted">Пока ничего не выдано.</p>
      ) : (
        <ul className="history__list">
          {done.map((o) => (
            <li key={o.id}>
              <span className="history__time">{formatTime(o.updatedAt)}</span>
              <span className="history__title">{o.recipeTitle}</span>
              <span className="history__guest">{o.guestName}</span>
              <span className={`pill pill--${o.status}`}>{o.status === "done" ? "Выдан" : "Отменён"}</span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function Queue({ orders, fresh, mode }: { orders: Order[]; fresh: Set<number>; mode: StreamMode }) {
  const now = useNow(30_000);
  const columns: { status: OrderStatus; title: string }[] = [
    { status: "new", title: "Новые" },
    { status: "making", title: "Готовятся" },
  ];
  return (
    <div className="queue">
      <p className={`queue__mode queue__mode--${mode}`}>
        <span className="queue__dot" aria-hidden="true" /> {MODE_LABEL[mode]}
      </p>
      <div className="queue__cols">
        {columns.map((col) => {
          const list = orders.filter((o) => o.status === col.status);
          return (
            <section key={col.status} className="queue__col" aria-labelledby={`col-${col.status}`}>
              <h2 id={`col-${col.status}`} className="queue__title">
                {col.title} <span className="queue__count">{list.length}</span>
              </h2>
              {list.length === 0 ? (
                <p className="queue__empty">{col.status === "new" ? "Новых заказов нет — гости ещё выбирают." : "Сейчас ничего не готовится."}</p>
              ) : (
                <ul className="queue__list">
                  {list.map((o) => (
                    <OrderCard key={o.id} order={o} fresh={fresh.has(o.id)} now={now} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      <History />
    </div>
  );
}

function Station() {
  const [tab, setTab] = useState<"queue" | "menus">("queue");
  const mode = useOrderStream(true);
  const orders = useQuery({
    queryKey: keys.orders("active"),
    queryFn: ({ signal }) => api.orders("active", signal),
    refetchInterval: mode === "live" ? false : 5000,
  });
  const [soundOn, setSoundOn] = useState(() => readString("chime") === "on");
  const [fresh, setFresh] = useState<Set<number>>(() => new Set());
  const [pings, setPings] = useState(0);
  const known = useRef<Set<number> | null>(null);

  // detect orders we haven't seen yet (works for SSE and polling alike)
  const ids = (orders.data ?? []).map((o) => o.id).join(",");
  useEffect(() => {
    if (!orders.data) return;
    const current = orders.data;
    if (known.current === null) {
      known.current = new Set(current.map((o) => o.id));
      return;
    }
    const added = current.filter((o) => o.status === "new" && !known.current!.has(o.id));
    current.forEach((o) => known.current!.add(o.id));
    if (added.length === 0) return;
    if (soundOn) chime();
    setPings((p) => p + 1);
    setFresh((s) => new Set([...s, ...added.map((o) => o.id)]));
    // let the glow fade; no cleanup on purpose so a quick follow-up order can't cancel it
    window.setTimeout(() => {
      setFresh((s) => {
        const n = new Set(s);
        added.forEach((o) => n.delete(o.id));
        return n;
      });
    }, 8000);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the id list
  }, [ids]);

  const newCount = (orders.data ?? []).filter((o) => o.status === "new").length;
  useEffect(() => {
    const base = "HomeBar · стойка";
    document.title = newCount > 0 ? `(${newCount}) ${base}` : base;
    return () => {
      document.title = "HomeBar · домашний бар";
    };
  }, [newCount]);

  async function toggleSound() {
    if (soundOn) {
      setSoundOn(false);
      writeString("chime", "off");
      return;
    }
    const ok = await unlockAudio();
    if (!ok) {
      toastError("Браузер не разрешил звук.");
      return;
    }
    setSoundOn(true);
    writeString("chime", "on");
    chime();
  }

  // a stored "on" still needs one user gesture before audio may play
  useEffect(() => {
    if (!soundOn) return;
    const unlock = () => void unlockAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, [soundOn]);

  return (
    <div className="page bar">
      <header className="page-head bar__head">
        <div>
          <p className="eyebrow">Только для хозяина</p>
          <h1 className="serif">Стойка</h1>
        </div>
        <div className="page-head__actions">
          <span key={pings} className={`bell ${pings ? "bell--ping" : ""}`} aria-hidden="true">
            <Icon name="bell" />
            {newCount > 0 && <span className="bell__count">{newCount}</span>}
          </span>
          <span className="visually-hidden" role="status" aria-live="polite">
            {newCount > 0 ? `${newCount} ${plural(newCount, ["новый заказ", "новых заказа", "новых заказов"])}` : ""}
          </span>
          <Button icon={soundOn ? "sound" : "mute"} onClick={toggleSound} aria-pressed={soundOn}>
            {soundOn ? "Звук включён" : "Включить звук"}
          </Button>
        </div>
      </header>

      <div className="tabs" role="tablist" aria-label="Разделы стойки">
        <button type="button" role="tab" id="tab-queue" aria-controls="panel-queue" aria-selected={tab === "queue"} className="tabs__tab" onClick={() => setTab("queue")}>
          Очередь {newCount > 0 && <span className="tabs__badge">{newCount}</span>}
        </button>
        <button type="button" role="tab" id="tab-menus" aria-controls="panel-menus" aria-selected={tab === "menus"} className="tabs__tab" onClick={() => setTab("menus")}>
          Меню для гостей
        </button>
      </div>

      <div role="tabpanel" id="panel-queue" aria-labelledby="tab-queue" hidden={tab !== "queue"}>
        {orders.isPending ? (
          <div className="queue__cols" aria-busy="true">
            <LoadingNote text="Загружаю очередь…" />
            <Skeleton h={200} r={16} />
            <Skeleton h={200} r={16} />
          </div>
        ) : orders.isError ? (
          <ErrorState error={orders.error} onRetry={() => orders.refetch()} />
        ) : (
          <Queue orders={orders.data} fresh={fresh} mode={mode} />
        )}
      </div>
      <div role="tabpanel" id="panel-menus" aria-labelledby="tab-menus" hidden={tab !== "menus"}>
        {tab === "menus" && <MenuManager />}
      </div>
    </div>
  );
}

export default function Bar() {
  const isHost = useIsHost();
  if (!isHost) {
    return (
      <div className="page page--narrow">
        <EmptyState
          title="Стойка — только для хозяина"
          action={
            <Button variant="primary" icon="key" onClick={requestLogin}>
              Войти как хозяин
            </Button>
          }
        >
          Здесь хозяин принимает заказы и составляет меню. Гостям — в <Link to="/menu">меню</Link>.
        </EmptyState>
      </div>
    );
  }
  return <Station />;
}
