import { useEffect, useRef } from "react";
import { Button } from "./Button";

interface LoadMoreProps {
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
  /** e.g. "Показать ещё" */
  label?: string;
  /** shown under the list when everything is loaded */
  doneText?: string;
}

/**
 * Infinite scroll: an IntersectionObserver sentinel loads the next page ~600px before the end,
 * with a visible «Показать ещё» button as the keyboard / no-IO fallback.
 */
export function LoadMore({ hasMore, loading, onMore, label = "Показать ещё", doneText }: LoadMoreProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onMoreRef = useRef(onMore);
  useEffect(() => {
    onMoreRef.current = onMore;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el || !hasMore || loading || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onMoreRef.current();
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading]);

  if (!hasMore) return doneText ? <p className="load-more__done">{doneText}</p> : null;
  return (
    <div ref={ref} className="load-more">
      <Button onClick={onMore} disabled={loading} aria-busy={loading}>
        {loading ? "Загружаю…" : label}
      </Button>
    </div>
  );
}
