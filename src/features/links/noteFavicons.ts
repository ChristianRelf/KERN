// Shows each link's site icon just before it in the note editor. The icon
// is a view-only widget (never part of the note's content or its Markdown).

import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, isTauri } from "@/lib/ipc";
import { measureTone, originOf } from "./links";

// One lookup per site for the whole session (the backend caches on disk).
const sources = new Map<string, Promise<string | null>>();

function iconFor(url: string): Promise<string | null> {
  const origin = originOf(url);
  if (!origin || !isTauri) return Promise.resolve(null);
  let p = sources.get(origin);
  if (!p) {
    p = api.system
      .favicon(url)
      .then((f) => (f.path ? convertFileSrc(f.path) : null))
      .catch(() => null);
    sources.set(origin, p);
  }
  return p;
}

/** Forget cached lookups (after the favicon cache is cleared). */
export function resetNoteFavicons() {
  sources.clear();
}

const GLOBE =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>';

function widget(href: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "note-favicon";
  el.contentEditable = "false";
  el.innerHTML = GLOBE;
  void iconFor(href).then((src) => {
    if (!src) return;
    const img = document.createElement("img");
    img.alt = "";
    img.width = 14;
    img.height = 14;
    img.decoding = "async";
    img.crossOrigin = "anonymous";
    img.onload = () => {
      el.replaceChildren(img);
      el.dataset.tone = measureTone(img);
    };
    img.src = src;
  });
  return el;
}

function build(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  let lastHref: string | null = null;
  let lastEnd = -1;
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "link");
    const href = (mark?.attrs.href as string | undefined) ?? null;
    // One icon per continuous run of the same link.
    if (href && !(href === lastHref && pos === lastEnd) && originOf(href)) {
      decos.push(Decoration.widget(pos, () => widget(href), { side: -1, ignoreSelection: true, key: `fav-${pos}-${href}` }));
    }
    lastHref = href;
    lastEnd = pos + node.nodeSize;
  });
  return DecorationSet.create(doc, decos);
}

const key = new PluginKey<DecorationSet>("noteFavicons");

export const NoteFavicons = Extension.create({
  name: "noteFavicons",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => build(state.doc),
          apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old),
        },
        props: { decorations: (state) => key.getState(state) },
      }),
    ];
  },
});
