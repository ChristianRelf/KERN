/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// A small code editor for quick edits: a transparent textarea over a
// highlighted copy of the text, both in one grid cell so they scroll and
// size together. Highlighting runs deferred; a line whose text changed since
// the last pass shows plain until the next one, so typing never waits on it.

import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { tokenize, type TokenLine } from "@/features/plugins/syntax";

/** Above this size the file is shown without highlighting. */
const HIGHLIGHT_LIMIT = 400_000;

function useTokens(code: string, lang: string | null, installed: string[]) {
  const deferred = useDeferredValue(code);
  const [result, setResult] = useState<{ lines: string[]; tokens: TokenLine[] } | null>(null);
  const key = installed.join(",");
  useEffect(() => {
    if (!lang || deferred.length > HIGHLIGHT_LIMIT) return setResult(null);
    let live = true;
    const handle = window.setTimeout(() => {
      tokenize(deferred, lang, installed)
        .then((tokens) => live && setResult(tokens ? { lines: deferred.split("\n"), tokens } : null))
        .catch(() => live && setResult(null));
    }, 30);
    return () => {
      live = false;
      window.clearTimeout(handle);
    };
  }, [deferred, lang, key]);
  return result;
}

function indentUnit(text: string) {
  const sample = text.split("\n", 400);
  const tabs = sample.filter((l) => l.startsWith("\t")).length;
  const spaces = sample.filter((l) => l.startsWith("  ")).length;
  return tabs > spaces ? "\t" : "  ";
}

export function CodeEditor({
  value,
  onChange,
  lang,
  installed,
  readOnly,
  onSave,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  lang: string | null;
  installed: string[];
  readOnly?: boolean;
  onSave?: () => void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const lines = useMemo(() => value.split("\n"), [value]);
  const highlighted = useTokens(value, lang, installed);
  const unit = useMemo(() => indentUnit(value), [value.length > 0]);

  // Tokens for a line, if the last highlighting pass saw the same text at the same place.
  const tokensFor = (i: number): TokenLine | null => (highlighted && highlighted.lines[i] === lines[i] ? highlighted.tokens[i] : null);

  const insert = (text: string) => {
    // execCommand keeps the textarea's own undo history intact.
    if (!document.execCommand("insertText", false, text)) {
      const ta = ref.current!;
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
      onChange(ta.value);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      onSave?.();
      return;
    }
    if (readOnly) return;
    const ta = e.currentTarget;
    if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      insert(unit);
    } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Keep the current line's indentation.
      const start = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
      const indent = /^[\t ]*/.exec(ta.value.slice(start, ta.selectionStart))?.[0] ?? "";
      if (indent) {
        e.preventDefault();
        insert("\n" + indent);
      }
    }
  };

  return (
    <div className="code-editor" data-readonly={readOnly || undefined}>
      <div className="code-editor__gutter" aria-hidden>
        {lines.map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <div className="code-editor__stack">
        <pre className="code-editor__view" aria-hidden>
          {lines.map((line, i) => {
            const toks = tokensFor(i);
            return (
              <div key={i} className="code-editor__line">
                {toks
                  ? toks.map((t, j) => (
                      <span key={j} style={{ color: t.color, fontStyle: t.fontStyle && t.fontStyle & 1 ? "italic" : undefined, fontWeight: t.fontStyle && t.fontStyle & 2 ? 600 : undefined }}>
                        {t.content}
                      </span>
                    ))
                  : line}
                {"\n"}
              </div>
            );
          })}
        </pre>
        <textarea
          ref={ref}
          className="code-editor__input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          wrap="off"
          aria-label={ariaLabel}
        />
      </div>
    </div>
  );
}
