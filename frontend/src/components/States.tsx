import type { ReactNode } from "react";
import { errorMessage } from "../api/client";
import { Button } from "./Button";
import "./states.css";

/** Thin line drawings (same 1.5px stroke as the icons). */
const ART = {
  empty: ["M18 26h28l-3 30H21Z", "M21 36h22", "M40 14c-6 0-9 4-9 9", "M50 22c0 9-6 14-12 14", "M50 22c-7 0-12 4-12 14"],
  error: ["M32 10 6 54h52Z", "M32 26v14", "M32 46h.01"],
  search: ["M28 46a16 16 0 1 0 0-32 16 16 0 0 0 0 32Z", "M40 42l14 14", "M22 30h12"],
};

function Art({ kind }: { kind: keyof typeof ART }) {
  return (
    <svg className="state__art" viewBox="0 0 64 64" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke">
        {ART[kind].map((d) => (
          <path key={d} d={d} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
    </svg>
  );
}

export function ErrorState({ error, onRetry, title = "Не удалось загрузить" }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div className="state state--error" role="alert">
      <Art kind="error" />
      <h3 className="state__title">{title}</h3>
      <p className="state__text">{errorMessage(error)}</p>
      {onRetry && (
        <Button icon="refresh" onClick={onRetry}>
          Попробовать снова
        </Button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
  art = "empty",
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  art?: "empty" | "search";
}) {
  return (
    <div className="state">
      <Art kind={art} />
      <h3 className="state__title">{title}</h3>
      {children && <div className="state__text">{children}</div>}
      {action && <div className="state__action">{action}</div>}
    </div>
  );
}

export function Skeleton({ w = "100%", h = 16, r, className }: { w?: string | number; h?: string | number; r?: number; className?: string }) {
  return <span className={`skeleton ${className ?? ""}`} style={{ display: "block", width: w, height: h, borderRadius: r }} aria-hidden="true" />;
}

/** Visually hidden live text for screen readers while loading. */
export function LoadingNote({ text = "Загрузка…" }: { text?: string }) {
  return (
    <span className="visually-hidden" role="status">
      {text}
    </span>
  );
}
