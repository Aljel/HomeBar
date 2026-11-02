import { memo } from "react";
import type { GlassKind, Tint } from "../lib/glass";

/** Outline drawings on a 120×120 grid; strokes stay 1.5px at any size (non-scaling). */
const DRAWINGS: Record<GlassKind, string[]> = {
  rocks: ["M37 46h46l-3 52H40Z", "M41 90h38", "M38.6 62h42.8", "M48 67l11-3 3 11-11 3Z", "M62 70l9-1 1 9-9 1Z"],
  coupe: ["M30 42h60c0 14-13 24-30 24S30 56 30 42Z", "M60 66v30", "M47 97h26", "M33.5 50h53", "M84 40a6 6 0 1 0-0.1 0", "M84 40a3 3 0 1 0-0.1 0"],
  martini: ["M30 38h60L60 68Z", "M60 68v28", "M47 97h26", "M35.5 43.5h49", "M47 30l15 24", "M57 49a4 4 0 1 0 0.1 0"],
  highball: ["M43 26h34l-2 72H45Z", "M46 90h28", "M43.6 42h32.8", "M68 14l-6 58", "M52 56a2 2 0 1 0 0.1 0", "M57 70a1.6 1.6 0 1 0 0.1 0", "M51 80a1.4 1.4 0 1 0 0.1 0"],
  wine: ["M42 24h36c2 18-2 36-18 38-16-2-20-20-18-38Z", "M60 62v32", "M47 95h26", "M42.6 38h34.8"],
  mug: ["M38 44h40v44a8 8 0 0 1-8 8H46a8 8 0 0 1-8-8Z", "M78 54h5a8 8 0 0 1 0 16h-5", "M50 36c-3-4 3-7 0-11", "M60 36c-3-4 3-7 0-11", "M70 36c-3-4 3-7 0-11"],
  shot: ["M47 54h26l-2.5 42h-21Z", "M50.5 89h19", "M47.7 66h24.6"],
  plate: ["M16 76a44 13 0 1 0 88 0a44 13 0 1 0-88 0", "M32 76a28 7.5 0 1 0 56 0a28 7.5 0 1 0-56 0", "M50 72c5-9 15-11 22-6-6 7-15 9-22 6Z", "M50 72c6-2 11-4 15-7"],
  bowl: ["M22 60h76c0 22-17 36-38 36S22 82 22 60Z", "M48 96h24", "M30 60c4-7 11-7 15 0 4-7 11-7 15 0 4-7 11-7 15 0 4-7 11-7 15 0"],
};

export const GlassArt = memo(function GlassArt({ kind, tint, className }: { kind: GlassKind; tint: Tint; className?: string }) {
  return (
    <div className={`glass-art ${className ?? ""}`} style={{ background: tint.bg, color: tint.ink }}>
      <svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
        <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke">
          {DRAWINGS[kind].map((d, i) => (
            <path key={i} d={d} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      </svg>
    </div>
  );
});
