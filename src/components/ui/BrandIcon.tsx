// Renders a Simple Icons brand mark as a monochrome SVG that inherits the
// surrounding text colour, so brand marks sit in the greyscale UI rather
// than adding their own colours.

import type { CSSProperties } from "react";

export interface BrandGlyph {
  title: string;
  path: string;
}

export function BrandIcon({ icon, size = 16, className = "", style }: { icon: BrandGlyph; size?: number; className?: string; style?: CSSProperties }) {
  return (
    <svg className={`brand-icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" role="img" aria-label={icon.title} style={style}>
      <path d={icon.path} />
    </svg>
  );
}
