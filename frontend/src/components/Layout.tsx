import { Suspense, useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { api } from "../api/client";
import { getToken, setToken, useIsHost } from "../lib/auth";
import { loginRequest } from "../lib/loginRequest";
import { useStore } from "../lib/store";
import { Button, IconButton } from "./Button";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";
import { LoginDialog, useLogout } from "./LoginDialog";
import { Toasts } from "./Toasts";
import "./layout.css";

const NAV = [
  { to: "/", label: "Лента", end: true },
  { to: "/recipes", label: "Рецепты" },
  { to: "/discover", label: "Попробуйте" },
  { to: "/menu", label: "Меню" },
  { to: "/pantry", label: "Продукты", host: true },
  { to: "/bar", label: "Стойка", host: true },
  { to: "/about", label: "О баре" },
] as const;

function NavLinks({ className }: { className: string }) {
  const isHost = useIsHost();
  return (
    <ul className={className}>
      {NAV.filter((n) => !("host" in n) || isHost).map((n) => (
        <li key={n.to}>
          <NavLink to={n.to} end={"end" in n} className="nav-link">
            {n.label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function Account() {
  const isHost = useIsHost();
  const logout = useLogout();
  if (!isHost) {
    return <IconButton icon="key" label="Войти как хозяин" look="plain" onClick={() => loginRequest.set(true)} />;
  }
  return (
    <span className="account">
      <button type="button" className="account__who" onClick={() => loginRequest.set(true)} title="Вы вошли как хозяин">
        <Icon name="user" /> Хозяин
      </button>
      <IconButton icon="logout" label="Выйти" look="plain" onClick={logout} />
    </span>
  );
}

export function RouteFallback() {
  return (
    <div className="page" aria-busy="true">
      <span className="visually-hidden" role="status">
        Загрузка страницы…
      </span>
      <div className="route-fallback">
        <div className="skeleton" style={{ height: 36, width: "40%" }} />
        <div className="skeleton" style={{ height: 16, width: "64%", marginTop: 16 }} />
        <div className="skeleton" style={{ height: 280, marginTop: 28, borderRadius: 16 }} />
      </div>
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const loginOpen = useStore(loginRequest);
  const location = useLocation();

  // validate a stored host token once on startup
  useEffect(() => {
    const token = getToken();
    if (!token) return;
    api
      .me()
      .then((r) => {
        // ignore the answer if the host has logged in again meanwhile
        if (!r.admin && getToken() === token) setToken(null);
      })
      .catch(() => {
        /* offline: keep the token, the next admin call will tell */
      });
  }, []);

  // close the phone nav sheet on navigation
  const [lastPath, setLastPath] = useState(location.pathname);
  if (lastPath !== location.pathname) {
    setLastPath(location.pathname);
    setMenuOpen(false);
  }

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  return (
    <>
      <a className="skip-link" href="#main">
        К содержимому
      </a>
      <header className="header">
        <div className="header__inner">
          <Link to="/" className="brand" aria-label="HomeBar — на главную">
            <Icon name="leaf" className="brand__leaf" />
            <span className="brand__name">HomeBar</span>
          </Link>
          <nav className="header__nav" aria-label="Разделы">
            <NavLinks className="nav" />
          </nav>
          <div className="header__end">
            <Account />
            <IconButton
              icon="menu"
              label="Разделы"
              look="plain"
              className="header__burger"
              aria-expanded={menuOpen}
              aria-haspopup="dialog"
              onClick={() => setMenuOpen(true)}
            />
          </div>
        </div>
      </header>

      <Dialog open={menuOpen} onClose={() => setMenuOpen(false)} title="Разделы" variant="sheet" className="nav-sheet">
        <nav aria-label="Разделы">
          <NavLinks className="nav-sheet__list" />
        </nav>
      </Dialog>

      <main id="main" tabIndex={-1} className="main">
        <Suspense fallback={<RouteFallback />}>{children}</Suspense>
      </main>

      <footer className="footer">
        <div className="footer__inner">
          <span>HomeBar · домашний бар и кухня</span>
          <span className="footer__links">
            <a href="https://unsplash.com/photos/Ihh0nT34AJs" target="_blank" rel="noopener noreferrer">
              Фото: Unsplash
            </a>
            <FooterLogin />
          </span>
        </div>
      </footer>

      <LoginDialog open={loginOpen} onClose={() => loginRequest.set(false)} />
      <Toasts />
    </>
  );
}

function FooterLogin() {
  const isHost = useIsHost();
  return (
    <Button variant="quiet" className="footer__login" onClick={() => loginRequest.set(true)}>
      {isHost ? "Вы хозяин" : "Вход для хозяина"}
    </Button>
  );
}
