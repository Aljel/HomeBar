import { createStore } from "./store";

export type ToastTone = "success" | "error" | "info";
export interface ToastAction {
  label: string;
  onClick: () => void;
}
export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  action?: ToastAction;
}

export const toastStore = createStore<Toast[]>([]);
let seq = 0;

export function dismissToast(id: number): void {
  toastStore.set((list) => list.filter((t) => t.id !== id));
}

export function toast(message: string, tone: ToastTone = "info", ttl = 4200, action?: ToastAction): void {
  const id = ++seq;
  toastStore.set((list) => [...list.slice(-3), { id, tone, message, action }]);
  window.setTimeout(() => dismissToast(id), ttl);
}

/** Info toast with an undo-style action ("Вернуть"); stays a little longer so it can be reached. */
export const toastWithAction = (m: string, action: ToastAction) => toast(m, "info", 7000, action);

export const toastSuccess = (m: string) => toast(m, "success");
export const toastError = (m: string) => toast(m, "error", 6000);
