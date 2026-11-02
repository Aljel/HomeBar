import { memo, useId, useMemo } from "react";
import type { Ingredient } from "../../api/types";
import type { GlassKind } from "../../lib/glass";
import { computeProportions, formatShare, stackLayers } from "../../lib/proportion";
import { strataColor } from "./palette";
import "./proportions.css";

interface Shape {
  /** outer outline paths (drawn with a thin stroke) */
  outline: string[];
  /** interior where the liquid sits (clip path) */
  inside: string;
  top: number;
  bottom: number;
}

/** Drinking vessels on a 120×120 grid; liquid strata are clipped to `inside`. */
const SHAPES: Partial<Record<GlassKind, Shape>> = {
  rocks: { outline: ["M35 40h50l-3.5 60h-43Z", "M40 92h40"], inside: "M36.5 48h47l-2.6 44H39.1Z", top: 48, bottom: 92 },
  highball: { outline: ["M42 18h36l-2 82H44Z", "M45 92h30"], inside: "M42.6 28h34.8l-1.8 64H44.4Z", top: 28, bottom: 92 },
  coupe: { outline: ["M24 40h72c0 17-15 29-36 29S24 57 24 40Z", "M60 69v29", "M45 100h30"], inside: "M25 46h70c-2.5 12-16 21-35 21S27.5 58 25 46Z", top: 46, bottom: 67 },
  martini: { outline: ["M24 34h72L60 72Z", "M60 72v26", "M45 100h30"], inside: "M28 38.5h64L60 69Z", top: 38.5, bottom: 69 },
  wine: { outline: ["M38 14h44c2.5 22-2.5 44-22 47-19.5-3-24.5-25-22-47Z", "M60 61v35", "M46 98h28"], inside: "M38.6 28h42.8c.6 14-4.4 29-21.4 31-17-2-22-17-21.4-31Z", top: 28, bottom: 59 },
  mug: { outline: ["M34 32h46v56a10 10 0 0 1-10 10H44a10 10 0 0 1-10-10Z", "M80 46h6a10 10 0 0 1 0 20h-6"], inside: "M35.5 42h43v46a8.5 8.5 0 0 1-8.5 8.5H44a8.5 8.5 0 0 1-8.5-8.5Z", top: 42, bottom: 96.5 },
  shot: { outline: ["M42 44h36l-3.5 56h-29Z", "M47 92h26"], inside: "M43 54h34l-2.4 38H45.4Z", top: 54, bottom: 92 },
};

interface Props {
  ingredients: readonly Ingredient[];
  glass: GlassKind;
  activeIndex: number | null;
  onActive: (i: number | null) => void;
}

/**
 * Minimal proportion visual: the glass in thin outline with horizontal strata whose heights ∝ share of
 * liquid volume (first ingredient at the bottom), plus one thin stacked bar. Hover/focus syncs with the list.
 */
export const Proportions = memo(function Proportions({ ingredients, glass, activeIndex, onActive }: Props) {
  const clipId = useId();
  const p = useMemo(() => computeProportions(ingredients), [ingredients]);
  const shape = SHAPES[glass] ?? SHAPES.rocks!;
  const layers = useMemo(() => stackLayers(p.parts, shape.top, shape.bottom, 2.2), [p.parts, shape]);
  if (p.parts.length < 2) return null;

  return (
    <figure className={`props ${activeIndex !== null ? "has-active" : ""}`}>
      <svg className="props__glass" viewBox="14 6 92 100" role="img" aria-label="Пропорции жидких ингредиентов в бокале">
        <defs>
          <clipPath id={clipId}>
            <path d={shape.inside} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          {layers.map((l) => (
            <rect
              key={l.index}
              x="0"
              y={l.y.toFixed(2)}
              width="120"
              height={(l.h + 0.3).toFixed(2)}
              fill={strataColor(l.index)}
              className={`props__layer ${activeIndex === l.index ? "is-active" : ""}`}
              onMouseEnter={() => onActive(l.index)}
              onMouseLeave={() => onActive(null)}
            />
          ))}
          {layers.slice(1).map((l) => (
            <line key={l.index} x1="0" x2="120" y1={(l.y + l.h).toFixed(2)} y2={(l.y + l.h).toFixed(2)} className="props__sep" />
          ))}
        </g>
        <g className="props__outline">
          {shape.outline.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
      </svg>
      <div className="props__bar" aria-hidden="true">
        {p.parts.map((part) => (
          <span
            key={part.index}
            className={`props__seg ${activeIndex === part.index ? "is-active" : ""}`}
            style={{ flexGrow: part.share, background: strataColor(part.index) }}
            onMouseEnter={() => onActive(part.index)}
            onMouseLeave={() => onActive(null)}
          />
        ))}
      </div>
      <figcaption className="props__caption">
        {activeIndex !== null && p.parts.some((x) => x.index === activeIndex) ? (
          (() => {
            const a = p.parts.find((x) => x.index === activeIndex)!;
            return (
              <>
                <strong>{a.name}</strong> · {formatShare(a.share)}
              </>
            );
          })()
        ) : (
          <>Высота слоя — доля объёма</>
        )}
      </figcaption>
    </figure>
  );
});
