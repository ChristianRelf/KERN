/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// The Kern logo, straight from assets/icon.svg (the same file the app icons
// are generated from), so every mark in the interface matches.
import iconUrl from "../../assets/icon.svg";

export function BrandMark({ className, size = 20 }: { className?: string; size?: number }) {
  return <img className={className} src={iconUrl} width={size} height={size} alt="" aria-hidden draggable={false} style={{ display: "block", flexShrink: 0 }} />;
}
