import { useState } from "react";
import { type GlassKind, tintFor } from "../lib/glass";
import { GlassArt } from "./GlassArt";

/** TheCocktailDB / TheMealDB serve small previews at `<url>/preview`. */
export function thumbUrl(url: string): string {
  return /\/\/www\.the(cocktail|meal)db\.com\/images\//.test(url) && !url.endsWith("/preview") ? `${url}/preview` : url;
}

interface ImgProps {
  src: string | null;
  alt: string;
  /** CSS aspect-ratio, e.g. "16 / 10" */
  ratio?: string;
  /** a calmer, shorter box for the line drawing (defaults to `ratio`) */
  placeholderRatio?: string;
  thumb?: boolean;
  /** drawing + tint used when there is no photo (or it fails to load) */
  glass: GlassKind;
  seed: string | number;
  className?: string;
  eager?: boolean;
  width?: number;
  height?: number;
}

/** Lazy image in a fixed aspect-ratio box; falls back to a line drawing of the glass/plate. */
export function Img({ src, alt, ratio = "16 / 10", placeholderRatio, thumb, glass, seed, className, eager, width = 640, height = 400 }: ImgProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const url = src ? (thumb ? thumbUrl(src) : src) : null;
  const showImage = url !== null && failed !== url;
  return (
    <div className={`img-box ${showImage ? "" : "img-box--art"} ${className ?? ""}`} style={{ aspectRatio: showImage ? ratio : (placeholderRatio ?? ratio) }}>
      {showImage ? (
        <img
          src={url}
          alt={alt}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          width={width}
          height={height}
          onError={() => setFailed(url)}
        />
      ) : (
        <GlassArt kind={glass} tint={tintFor(seed)} />
      )}
    </div>
  );
}
