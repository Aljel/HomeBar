import type { ReactNode } from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

interface ConfirmProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({ open, title, children, confirmLabel, danger, busy, onConfirm, onClose }: ConfirmProps) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="stack">
        <div className="muted">{children}</div>
        <div className="dialog-actions">
          <Button onClick={onClose}>Отмена</Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy}>
            {busy ? "Минутку…" : confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
