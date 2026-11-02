import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../api/client";
import { keys, usePage } from "../api/queries";
import type { Page } from "../api/types";
import { useIsHost } from "../lib/auth";
import { toastError, toastSuccess } from "../lib/toast";
import { Button } from "./Button";
import { Markdown } from "./Markdown";
import { ErrorState, Skeleton } from "./States";
import "./page-text.css";

interface EditorProps {
  slug: string;
  page: Page | null;
  fallbackTitle: string;
  fallbackBody: string;
  onDone: () => void;
}

/** In-place markdown editor with live preview for an /api/pages entry. */
export function PageEditor({ slug, page, fallbackTitle, fallbackBody, onDone }: EditorProps) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(page?.title || fallbackTitle);
  const [body, setBody] = useState(page?.body ?? fallbackBody);
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const saved = await api.savePage(slug, title.trim() || fallbackTitle, body);
      qc.setQueryData(keys.page(slug), saved);
      toastSuccess("Текст сохранён.");
      onDone();
    } catch (err) {
      toastError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="page-editor" onSubmit={save}>
      <div className="page-editor__grid">
        <div className="stack">
          <label className="field">
            <span>Заголовок</span>
            <input className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            <span>Текст (markdown)</span>
            <textarea className="textarea page-editor__ta" value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
        </div>
        <section className="page-editor__preview" aria-label="Предпросмотр">
          <p className="eyebrow">Предпросмотр</p>
          <h2>{title || fallbackTitle}</h2>
          <Markdown source={body} />
        </section>
      </div>
      <div className="row">
        <Button type="submit" variant="primary" icon="check" disabled={saving}>
          {saving ? "Сохраняю…" : "Сохранить"}
        </Button>
        <Button onClick={onDone}>Отмена</Button>
      </div>
    </form>
  );
}

interface PageTextProps {
  slug: string;
  fallbackTitle: string;
  fallbackBody: string;
  className?: string;
}

/** Markdown page block from /api/pages (title as h1) with an editor for the host. */
export function PageText({ slug, fallbackTitle, fallbackBody, className }: PageTextProps) {
  const q = usePage(slug);
  const isHost = useIsHost();
  const [editing, setEditing] = useState(false);

  if (q.isPending) {
    return (
      <div className={`page-text ${className ?? ""}`} aria-busy="true">
        <Skeleton h={40} w="55%" />
        <Skeleton h={16} w="90%" className="page-text__sk" />
        <Skeleton h={16} w="75%" className="page-text__sk" />
      </div>
    );
  }
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  const page = q.data;
  if (editing) {
    return <PageEditor slug={slug} page={page} fallbackTitle={fallbackTitle} fallbackBody={fallbackBody} onDone={() => setEditing(false)} />;
  }
  return (
    <div className={`page-text ${className ?? ""}`}>
      <h1 className="page-text__title serif">{page?.title || fallbackTitle}</h1>
      <Markdown source={page?.body || fallbackBody} className="page-text__body" />
      {isHost && (
        <Button icon="edit" className="page-text__edit" onClick={() => setEditing(true)}>
          Изменить текст
        </Button>
      )}
    </div>
  );
}
