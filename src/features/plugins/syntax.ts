// Syntax plugins on the frontend: which grammar a file uses, which are
// installed, and a Shiki highlighter that loads installed grammars on demand.
// Grammars are JSON data fetched from the backend (verified there); they are
// never executed. Token colours come from CSS variables (--code-*), so
// highlighting follows the app's light and dark themes.

import { useQuery } from "@tanstack/react-query";
import { createCssVariablesTheme, createHighlighterCore, type HighlighterCore, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { toast, toastError } from "@/stores/toast";
import { GRAMMAR_META, SYNTAXES, type SyntaxPlugin } from "./catalog";

export type { SyntaxPlugin };

const BY_ID = new Map(SYNTAXES.map((s) => [s.id, s]));

export function syntaxById(id: string): SyntaxPlugin | undefined {
  return BY_ID.get(id);
}

/** The syntax for a file name: exact names first (Dockerfile, .env), then the extension. */
export function syntaxForFile(name: string): SyntaxPlugin | undefined {
  const lower = name.toLowerCase();
  const byName = SYNTAXES.find((s) => s.names.includes(lower));
  if (byName) return byName;
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  return ext ? SYNTAXES.find((s) => s.exts.includes(ext)) : undefined;
}

/** Every grammar a plugin installs. */
export const grammarsOf = (s: SyntaxPlugin) => [s.id, ...s.requires];

export function useInstalledGrammars() {
  return useQuery({ queryKey: ["plugins", "installed"], queryFn: api.plugins.installed, staleTime: Infinity });
}

export async function installSyntaxes(list: SyntaxPlugin[]): Promise<boolean> {
  if (!list.length) return true;
  try {
    await api.plugins.install([...new Set(list.flatMap(grammarsOf))]);
    toast(list.length === 1 ? `${list[0].name} syntax installed` : `Installed ${list.length} syntaxes`);
    return true;
  } catch (e) {
    toastError(describeError(e, "Couldn't install the syntax."));
    return false;
  } finally {
    invalidate("plugins");
  }
}

/** Removes a plugin's grammar, keeping ones other installed plugins still need. */
export async function removeSyntax(s: SyntaxPlugin, installed: string[]) {
  const stillNeeded = new Set(SYNTAXES.filter((o) => o.id !== s.id && installed.includes(o.id)).flatMap(grammarsOf));
  const drop = grammarsOf(s).filter((g) => !stillNeeded.has(g));
  try {
    await api.plugins.remove(drop);
    forget(drop);
  } catch (e) {
    toastError(describeError(e, "Couldn't remove the syntax."));
  } finally {
    invalidate("plugins");
  }
}

// ------------------------------------------------------------ highlighter

const theme = createCssVariablesTheme({ name: "kern", variablePrefix: "--code-", variableDefaults: {}, fontStyle: true });
let core: Promise<HighlighterCore> | null = null;
const loaded = new Map<string, Promise<void>>();

function highlighter() {
  core ??= createHighlighterCore({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) });
  return core;
}

function forget(names: string[]) {
  // Shiki can't unload a grammar; a fresh highlighter picks up the change.
  if (names.some((n) => loaded.has(n))) {
    core = null;
    loaded.clear();
  }
}

function load(h: HighlighterCore, name: string, installed: Set<string>): Promise<void> {
  let p = loaded.get(name);
  if (!p) {
    p = (async () => {
      const meta = GRAMMAR_META[name];
      // Embedded languages are used when installed; missing ones just stay plain.
      const embedded = (meta?.embedded ?? []).filter((e) => installed.has(e) && GRAMMAR_META[e]);
      await Promise.all(embedded.map((e) => load(h, e, installed)));
      const grammar = JSON.parse(await api.plugins.grammar(name));
      await h.loadLanguage({ ...grammar, name, scopeName: meta?.scope ?? grammar.scopeName, embeddedLangs: embedded });
    })();
    loaded.set(name, p);
    p.catch(() => loaded.delete(name));
  }
  return p;
}

export type TokenLine = ThemedToken[];

/** Tokenises code with an installed grammar. Null when it isn't installed. */
export async function tokenize(code: string, lang: string, installed: string[]): Promise<TokenLine[] | null> {
  if (!installed.includes(lang)) return null;
  const h = await highlighter();
  await load(h, lang, new Set(installed));
  return h.codeToTokensBase(code, { lang, theme: "kern" });
}
