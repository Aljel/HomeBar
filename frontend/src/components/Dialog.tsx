import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconButton } from "./Button";
import "./dialog.css";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** center = card; sheet = bottom sheet (phones); drawer = side panel */
  variant?: "center" | "sheet" | "drawer";
  children: ReactNode;
  className?: string;
  /** Hide the visible title (still used as accessible name). */
  hideTitle?: boolean;
}

/**
 * Native <dialog> + showModal(): the rest of the page becomes inert (focus is trapped),
 * Esc closes via the "cancel" event, focus returns to the opener on close.
 */
export function Dialog({ open, onClose, title, variant = "center", children, className, hideTitle }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      onCloseRef.current();
    };
    d.addEventListener("cancel", onCancel);
    return () => d.removeEventListener("cancel", onCancel);
  }, []);

  return (
    <dialog
      ref={ref}
      className={`dialog dialog--${variant} ${className ?? ""}`}
      aria-labelledby={titleId}
      onClick={(e) => {
        // a click on the ::backdrop targets the dialog element itself
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {open && (
        <div className="dialog__panel">
          {variant === "sheet" && <div className="dialog__grip" aria-hidden="true" />}
          <header className={`dialog__head ${hideTitle ? "visually-hidden" : ""}`}>
            <h2 id={titleId} className="dialog__title">
              {title}
            </h2>
          </header>
          <IconButton icon="close" label="Закрыть" look="plain" className="dialog__close" onClick={onClose} />
          <div className="dialog__content">{children}</div>
        </div>
      )}
    </dialog>
  );
}
