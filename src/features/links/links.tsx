// Rich links: favicon + readable URL, with consistent actions everywhere a
// link appears (task descriptions and attachments, notes, whiteboard cards,
// project resources, bookmarks, inbox).
//
// Favicons come from Kern's local cache (fetched once per site by the Rust
// favicon service, if allowed in Privacy). The query cache dedupes
// concurrent requests per origin, images load lazily, and a missing or
// broken icon falls back to a neutral globe — never a broken image.

import { ClipboardCopy, ExternalLink, Globe, Mail, Pencil, Trash, Type } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, describeError, isTauri } from "@/lib/ipc";
import { ContextMenu, type MenuItems } from "@/components/ui/Menu";
import { prompt } from "@/components/ui/Dialog";
import { toast, toastError } from "@/stores/toast";
import { useSetting } from "@/stores/settings";

export function normalizeUrl(raw: string): string {
  const u = raw.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`;
}

export function originOf(raw: string): string | null {
  try {
    const u = new URL(normalizeUrl(raw));
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** "https://www.github.com/example/project/" → "github.com/example/project" */
export function displayUrl(raw: string, max = 64): string {
  try {
    const u = new URL(normalizeUrl(raw));
    if (u.protocol === "mailto:") return u.pathname;
    const path = decodeURI(u.pathname).replace(/\/$/, "");
    const s = `${u.host.replace(/^www\./, "")}${path}${u.search ? "?…" : ""}`;
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  } catch {
    return raw;
  }
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/** Web links in free text, in order, without duplicates or trailing punctuation. */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.match(URL_RE) ?? []) {
    let u = m.replace(/[.,;:!?]+$/, "");
    // Drop an unbalanced closing bracket (e.g. "(see https://x.y/z)").
    while (/[)\]]$/.test(u) && (u.match(/[([]/g)?.length ?? 0) < (u.match(/[)\]]/g)?.length ?? 0)) u = u.slice(0, -1);
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

export function useFavicon(url: string) {
  const origin = originOf(url);
  return useQuery({
    queryKey: ["favicon", origin],
    queryFn: () => api.system.favicon(url),
    enabled: !!origin && isTauri,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
  });
}

// Average tone of an icon's visible pixels, measured once per icon. Icons
// that are nearly black (or white) would vanish on the matching theme, so
// those — and only those — get a small contrasting plate.
const tones = new Map<string, "dark" | "light" | "mid">();

export function measureTone(img: HTMLImageElement): "dark" | "light" | "mid" {
  const cached = tones.get(img.src);
  if (cached) return cached;
  let tone: "dark" | "light" | "mid" = "mid";
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 16;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(img, 0, 0, 16, 16);
      const d = ctx.getImageData(0, 0, 16, 16).data;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 64) continue;
        sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        n++;
      }
      if (n > 8) tone = sum / n < 50 ? "dark" : sum / n > 215 ? "light" : "mid";
    }
  } catch {
    // Unreadable pixels: leave the icon as it is.
  }
  tones.set(img.src, tone);
  return tone;
}

export function Favicon({ url, size = 16, style }: { url: string; size?: number; style?: CSSProperties }) {
  const { data } = useFavicon(url);
  const [broken, setBroken] = useState(false);
  const [tone, setTone] = useState<"dark" | "light" | "mid">("mid");
  const isMail = /^mailto:/i.test(url);
  const box: CSSProperties = { width: size, height: size, ...style };
  if (data?.path && !broken)
    return (
      <span className="favicon-img" data-tone={tone} style={box}>
        <img
          src={convertFileSrc(data.path)}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          crossOrigin="anonymous"
          onLoad={(e) => setTone(measureTone(e.currentTarget))}
          onError={() => setBroken(true)}
          draggable={false}
        />
      </span>
    );
  const Icon = isMail ? Mail : Globe;
  return (
    <span className="favicon-img favicon-img--fallback" style={box} aria-hidden>
      <Icon size={Math.round(size * 0.82)} strokeWidth={1.75} />
    </span>
  );
}

export async function openLink(url: string) {
  try {
    await api.system.open(normalizeUrl(url));
  } catch (e) {
    toastError(describeError(e, "Couldn't open the link."));
  }
}

export async function copyLink(url: string) {
  try {
    await navigator.clipboard.writeText(normalizeUrl(url));
    toast("Link copied");
  } catch {
    toastError("Couldn't copy the link.");
  }
}

export function linkMenu(url: string, opts: { onEdit?: (url: string) => void; onRename?: (title: string) => void; onRemove?: () => void; title?: string | null } = {}): MenuItems {
  return [
    { label: "Open link", icon: ExternalLink, onSelect: () => void openLink(url) },
    { label: "Copy link", icon: ClipboardCopy, onSelect: () => void copyLink(url) },
    opts.onEdit && { type: "separator" },
    opts.onEdit && {
      label: "Edit link…",
      icon: Pencil,
      onSelect: async () => {
        const v = await prompt({ title: "Edit link", initial: url, confirmLabel: "Save" });
        if (v && v !== url) opts.onEdit!(normalizeUrl(v));
      },
    },
    opts.onRename && {
      label: "Rename…",
      icon: Type,
      onSelect: async () => {
        const v = await prompt({ title: "Link title", initial: opts.title ?? displayUrl(url), confirmLabel: "Save" });
        if (v) opts.onRename!(v);
      },
    },
    opts.onRemove && { type: "separator" },
    opts.onRemove && { label: "Remove link", icon: Trash, danger: true, onSelect: opts.onRemove },
  ];
}

/**
 * A link row/chip: favicon, optional title, and the readable URL. Click
 * opens it in the browser; right-click (or `trailing` actions) for more.
 */
export function RichLink({
  url,
  title,
  size = "md",
  onEdit,
  onRename,
  onRemove,
  trailing,
}: {
  url: string;
  title?: string | null;
  size?: "sm" | "md" | "lg";
  onEdit?: (url: string) => void;
  onRename?: (title: string) => void;
  onRemove?: () => void;
  trailing?: ReactNode;
}) {
  const icon = size === "sm" ? 14 : size === "lg" ? 20 : 16;
  const display = displayUrl(url);
  const showTitle = title && title !== url && title !== display;
  return (
    <ContextMenu items={() => linkMenu(url, { onEdit, onRename, onRemove, title })}>
      <div className={`rich-link rich-link--${size}`}>
        <a
          href={normalizeUrl(url)}
          className="rich-link__main"
          title={normalizeUrl(url)}
          onClick={(e) => {
            e.preventDefault();
            void openLink(url);
          }}
        >
          <Favicon url={url} size={icon} />
          {showTitle ? (
            <>
              <span className="rich-link__title truncate">{title}</span>
              <span className="rich-link__url truncate">{display}</span>
            </>
          ) : (
            <span className="rich-link__title truncate">{display}</span>
          )}
        </a>
        {trailing}
      </div>
    </ContextMenu>
  );
}

/** Whether titles should be fetched for new links (Privacy settings). */
export function useTitleFetching() {
  const network = useSetting("privacy.network");
  const previews = useSetting("data.linkPreviews");
  return network && previews;
}
