import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../api/client";
import { invalidatePantryDerived, keys } from "../api/queries";
import type { PantryItem } from "../api/types";
import { normalizeName } from "../lib/pantry";
import { toastError, toastWithAction } from "../lib/toast";

export interface AddResult {
  /** display names of products that were not in the pantry before */
  added: string[];
  /** typed names that resolved to something already there */
  already: string[];
}

/** Host-only pantry writes with cache updates; every change refreshes availability & co. */
export function usePantryActions() {
  const qc = useQueryClient();
  const [pending, setPending] = useState(0);

  async function add(names: string[]): Promise<AddResult | null> {
    if (names.length === 0) return { added: [], already: [] };
    const before = new Set((qc.getQueryData<PantryItem[]>(keys.pantry) ?? []).map((p) => p.key));
    setPending((n) => n + 1);
    try {
      const list = await api.addToPantry(names);
      qc.setQueryData(keys.pantry, list);
      invalidatePantryDerived(qc);
      const fresh = list.filter((p) => !before.has(p.key));
      // which typed names produced nothing new: compare against fresh items' names (best effort)
      const freshNames = new Set(fresh.flatMap((p) => [normalizeName(p.name), normalizeName(p.nameEn)]));
      const already = fresh.length >= names.length ? [] : names.filter((n) => !freshNames.has(normalizeName(n)));
      return { added: fresh.map((p) => p.name), already: already.slice(0, Math.max(0, names.length - fresh.length)) };
    } catch (e) {
      toastError(errorMessage(e));
      return null;
    } finally {
      setPending((n) => n - 1);
    }
  }

  async function remove(item: PantryItem): Promise<void> {
    const prev = qc.getQueryData<PantryItem[]>(keys.pantry);
    qc.setQueryData<PantryItem[]>(keys.pantry, (old) => old?.filter((p) => p.key !== item.key));
    try {
      await api.removeFromPantry(item.key);
      invalidatePantryDerived(qc);
      toastWithAction(`Убрано: ${item.name.toLowerCase()}`, { label: "Вернуть", onClick: () => void add([item.name]) });
    } catch (e) {
      if (prev) qc.setQueryData(keys.pantry, prev);
      toastError(errorMessage(e));
    }
  }

  async function clear(): Promise<boolean> {
    setPending((n) => n + 1);
    try {
      await api.clearPantry();
      qc.setQueryData<PantryItem[]>(keys.pantry, []);
      invalidatePantryDerived(qc);
      return true;
    } catch (e) {
      toastError(errorMessage(e));
      return false;
    } finally {
      setPending((n) => n - 1);
    }
  }

  return { add, remove, clear, busy: pending > 0 };
}
