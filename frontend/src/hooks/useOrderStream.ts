import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { keys } from "../api/queries";
import type { Order } from "../api/types";

const hasEventSource = typeof EventSource !== "undefined";

export type StreamMode = "connecting" | "live" | "polling";

const isActive = (o: Order) => o.status === "new" || o.status === "making";

/** Applies an order event to the cached active queue (oldest first). */
export function upsertActive(list: Order[] | undefined, o: Order): Order[] {
  const rest = (list ?? []).filter((x) => x.id !== o.id);
  if (!isActive(o)) return rest;
  return [...rest, o].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
}

/**
 * Live order queue over SSE (`/api/orders/stream?token=`). Falls back to polling
 * when EventSource is missing or keeps failing, and retries the stream later.
 */
export function useOrderStream(enabled: boolean): StreamMode {
  const qc = useQueryClient();
  const [mode, setMode] = useState<StreamMode>("connecting");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled || !hasEventSource) return;
    let errors = 0;
    let retryTimer = 0;
    const es = new EventSource(api.orderStreamUrl());
    es.onopen = () => {
      errors = 0;
      setMode("live");
      // catch up on anything that happened while disconnected
      qc.invalidateQueries({ queryKey: keys.orders("active") });
    };
    es.addEventListener("order", (ev) => {
      try {
        const o = JSON.parse((ev as MessageEvent<string>).data) as Order;
        qc.setQueryData<Order[]>(keys.orders("active"), (old) => upsertActive(old, o));
        qc.setQueryData(keys.order(o.id), o);
        qc.invalidateQueries({ queryKey: keys.orders("all"), refetchType: "active" });
      } catch {
        /* malformed event: ignore */
      }
    });
    es.onerror = () => {
      errors += 1;
      if (es.readyState === EventSource.CLOSED || errors >= 3) {
        es.close();
        setMode("polling");
        window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(() => setAttempt((a) => a + 1), 30_000);
      } else {
        // the browser is reconnecting: poll meanwhile so the queue doesn't freeze
        setMode("connecting");
      }
    };
    return () => {
      es.close();
      window.clearTimeout(retryTimer);
    };
  }, [enabled, attempt, qc]);

  return enabled && hasEventSource ? mode : "polling";
}
