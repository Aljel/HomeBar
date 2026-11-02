import { useStore } from "../lib/store";
import { dismissToast, toastStore } from "../lib/toast";
import { Icon } from "./Icon";
import "./toasts.css";

export function Toasts() {
  const toasts = useStore(toastStore);
  return (
    <div className="toasts" role="region" aria-label="Уведомления">
      <div aria-live="polite" aria-atomic="false" className="toasts__list">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.tone}`} role={t.tone === "error" ? "alert" : "status"}>
            <span className="toast__mark" aria-hidden="true">
              <Icon name={t.tone === "error" ? "info" : t.tone === "success" ? "check" : "info"} />
            </span>
            <span className="toast__msg">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="toast__action"
                onClick={() => {
                  t.action?.onClick();
                  dismissToast(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className="toast__x" onClick={() => dismissToast(t.id)} aria-label="Скрыть уведомление">
              <Icon name="close" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
