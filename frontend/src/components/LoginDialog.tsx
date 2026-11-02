import { useState, type FormEvent } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { api, errorMessage, isApiError } from "../api/client";
import { setToken, useIsHost } from "../lib/auth";
import { toastSuccess } from "../lib/toast";
import { Dialog } from "./Dialog";
import { Button } from "./Button";

const notDiscover = (q: Query) => q.queryKey[0] !== "discover";

/** Drops the host token and every host-only bit of cached data. */
export function useLogout() {
  const qc = useQueryClient();
  return () => {
    setToken(null);
    // host-only data must not linger in the cache for the next person at this device
    qc.removeQueries({ queryKey: ["orders"] });
    void qc.invalidateQueries({ predicate: notDiscover });
    toastSuccess("Вы вышли. Снова в режиме гостя.");
  };
}

export function LoginDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const isHost = useIsHost();
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setPassword("");
    setError(null);
    onClose();
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password) {
      setError("Введите пароль.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { token } = await api.login(password);
      setToken(token);
      // refresh host-dependent data in the background; leave discover alone (re-fetching it
      // would deal a new random hand) and don't keep the dialog waiting on slow upstreams
      void qc.invalidateQueries({ predicate: notDiscover });
      toastSuccess("Вы вошли как хозяин.");
      close();
    } catch (err) {
      setError(isApiError(err, 401) ? "Неверный пароль." : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const doLogout = useLogout();
  function logout() {
    doLogout();
    close();
  }

  return (
    <Dialog open={open} onClose={close} title={isHost ? "Вы хозяин" : "Вход для хозяина"}>
      {isHost ? (
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>
            Можно редактировать рецепты, составлять меню и принимать заказы.
          </p>
          <div className="dialog-actions">
            <Button icon="logout" onClick={logout}>
              Выйти
            </Button>
            <Button variant="primary" onClick={close}>
              Готово
            </Button>
          </div>
        </div>
      ) : (
        <form className="stack" onSubmit={submit} noValidate>
          <p className="muted" style={{ margin: 0 }}>
            Гостям пароль не нужен — меню и заказы открыты всем.
          </p>
          <label className="field">
            <span>Пароль</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "login-error" : undefined}
              autoFocus
            />
          </label>
          {error && (
            <p id="login-error" className="field-error" role="alert" style={{ margin: 0 }}>
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <Button onClick={close}>Отмена</Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Проверяю…" : "Войти"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
