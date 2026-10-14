import { useEditor, EditorContent, BubbleMenu, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { NoteFavicons } from "@/features/links/noteFavicons";
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  SquareCode,
  Strikethrough,
  Plus,
  Pilcrow,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Menu";
import { prompt } from "@/components/ui/Dialog";
import { api } from "@/lib/ipc";

export function getMarkdown(editor: Editor): string {
  return (editor.storage as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown();
}

async function setLink(editor: Editor) {
  const prev = editor.getAttributes("link").href as string | undefined;
  const url = await prompt({ title: prev ? "Edit link" : "Add link", initial: prev ?? "https://", confirmLabel: "Apply" });
  if (url === null) return;
  if (!url || url === "https://") editor.chain().focus().extendMarkRange("link").unsetLink().run();
  else editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
}

export function insertItems(editor: Editor) {
  return [
    { label: "Heading 1", icon: Heading1, shortcut: "# ", onSelect: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
    { label: "Heading 2", icon: Heading2, shortcut: "## ", onSelect: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: "Heading 3", icon: Heading3, shortcut: "### ", onSelect: () => editor.chain().focus().toggleHeading({ level: 3 }).run() },
    { label: "Bullet list", icon: List, shortcut: "- ", onSelect: () => editor.chain().focus().toggleBulletList().run() },
    { label: "Numbered list", icon: ListOrdered, shortcut: "1. ", onSelect: () => editor.chain().focus().toggleOrderedList().run() },
    { label: "Checklist", icon: ListChecks, shortcut: "[ ] ", onSelect: () => editor.chain().focus().toggleTaskList().run() },
    { label: "Quote", icon: Quote, shortcut: "> ", onSelect: () => editor.chain().focus().toggleBlockquote().run() },
    { label: "Code block", icon: SquareCode, shortcut: "``` ", onSelect: () => editor.chain().focus().toggleCodeBlock().run() },
    { label: "Divider", icon: Minus, shortcut: "---", onSelect: () => editor.chain().focus().setHorizontalRule().run() },
  ];
}

// ------------------------------------------------------------ slash menu

interface SlashState {
  /** Position of the "/" that opened the menu. */
  from: number;
  query: string;
  index: number;
  left: number;
  top: number;
  /** Open upwards when there's no room below. */
  up: boolean;
}

function slashItems(editor: Editor, query: string) {
  const all = [
    { label: "Text", icon: Pilcrow, shortcut: "", onSelect: () => editor.chain().focus().setParagraph().run() },
    ...insertItems(editor),
  ];
  const q = query.toLowerCase().replace(/\s/g, "");
  return q ? all.filter((i) => i.label.toLowerCase().replace(/\s/g, "").includes(q)) : all;
}

/** Finds a "/command" being typed just before the cursor. */
function detectSlash(editor: Editor): SlashState | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const $from = selection.$from;
  if ($from.parent.type.name === "codeBlock") return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const m = /(?:^|\s)\/([a-z0-9]{0,20})$/i.exec(before);
  if (!m) return null;
  const from = selection.from - m[1].length - 1;
  const c = editor.view.coordsAtPos(from);
  const up = window.innerHeight - c.bottom < 300;
  return { from, query: m[1], index: 0, left: c.left, top: up ? c.top - 4 : c.bottom + 4, up };
}

function SlashMenu({ editor, state, onPick, onHover }: { editor: Editor; state: SlashState; onPick: (i: number) => void; onHover: (i: number) => void }) {
  const items = slashItems(editor, state.query);
  if (!items.length) return null;
  return createPortal(
    <div
      className="menu slash-menu"
      role="listbox"
      aria-label="Insert block"
      style={{ position: "fixed", left: state.left, ...(state.up ? { bottom: window.innerHeight - state.top } : { top: state.top }) }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.map((it, i) => {
        const Icon = it.icon;
        return (
          <div
            key={it.label}
            className="menu__item"
            role="option"
            aria-selected={i === state.index}
            data-highlighted={i === state.index ? "" : undefined}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(i)}
          >
            <Icon strokeWidth={1.75} />
            <span className="truncate grow">{it.label}</span>
            {it.shortcut && <span className="menu__hint">{it.shortcut.trim()}</span>}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

/**
 * Markdown-backed rich text editor. Content is stored as Markdown (portable);
 * typing Markdown syntax formats inline, and "/" opens a block menu. Changes
 * are reported via onChange (debounced by the caller) and flushed on unmount.
 */
export function NoteEditor({
  initial,
  onChange,
  onFlush,
  onBlur,
  placeholder = "Start writing… Type / for blocks, or use Markdown: #, -, [ ], ```, **bold**",
  autoFocus,
  onEditor,
  compact,
}: {
  initial: string;
  onChange: (markdown: string) => void;
  onFlush?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  onEditor?: (e: Editor | null) => void;
  /** Smaller type and no minimum height (task descriptions). */
  compact?: boolean;
}) {
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const blurRef = useRef(onBlur);
  blurRef.current = onBlur;
  const [slash, setSlash] = useState<SlashState | null>(null);
  const slashRef = useRef(slash);
  slashRef.current = slash;
  // The "/" whose menu was dismissed with Escape stays closed.
  const dismissedAt = useRef<number | null>(null);
  const editorRef = useRef<Editor | null>(null);

  const pick = (e: Editor, i: number) => {
    const s = slashRef.current;
    if (!s) return;
    const item = slashItems(e, s.query)[i];
    setSlash(null);
    if (!item) return;
    e.chain().focus().deleteRange({ from: s.from, to: e.state.selection.from }).run();
    item.onSelect();
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
      NoteFavicons,
      Placeholder.configure({ placeholder }),
      Markdown.configure({ html: false, tightLists: true, linkify: true, transformPastedText: true, breaks: false }),
    ],
    content: initial,
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: { class: compact ? "prose prose--compact" : "prose", spellcheck: "true" },
      handleKeyDown: (_view, event) => {
        const s = slashRef.current;
        const ed = editorRef.current;
        if (!s || !ed) return false;
        const count = slashItems(ed, s.query).length;
        if (!count) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const d = event.key === "ArrowDown" ? 1 : -1;
          setSlash({ ...s, index: (s.index + d + count) % count });
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          pick(ed, s.index);
          return true;
        }
        if (event.key === "Escape") {
          dismissedAt.current = s.from;
          setSlash(null);
          return true;
        }
        return false;
      },
      handleClick: (_view, _pos, event) => {
        const a = (event.target as HTMLElement).closest("a");
        if (a && (event.ctrlKey || event.metaKey)) {
          void api.system.open(a.getAttribute("href") ?? "");
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => changeRef.current(getMarkdown(e)),
    onTransaction: ({ editor: e }) => {
      const next = detectSlash(e);
      // Once the dismissed "/" is gone, a new one may open the menu again.
      if (!next) dismissedAt.current = null;
      if (!next || next.from === dismissedAt.current) {
        if (slashRef.current) setSlash(null);
        return;
      }
      const prev = slashRef.current;
      setSlash(prev && prev.from === next.from ? { ...next, index: prev.query === next.query ? prev.index : 0 } : next);
    },
    onBlur: () => {
      setSlash(null);
      blurRef.current?.();
    },
  });
  editorRef.current = editor;

  // A fixed menu can't follow scrolling; close it instead.
  const slashOpen = !!slash;
  useEffect(() => {
    if (!slashOpen) return;
    const close = () => setSlash(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [slashOpen]);

  useEffect(() => {
    onEditor?.(editor);
    return () => onEditor?.(null);
  }, [editor, onEditor]);

  useEffect(() => () => onFlush?.(), [onFlush]);

  if (!editor) return null;
  return (
    <>
      <BubbleMenu editor={editor} tippyOptions={{ duration: 120, maxWidth: "none" }} shouldShow={({ editor: e, from, to }) => from !== to && !e.isActive("codeBlock")}>
        <div className="bubble" role="toolbar" aria-label="Formatting">
          <IconButton icon={Bold} label="Bold" shortcut="Mod+B" size="sm" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()} />
          <IconButton icon={Italic} label="Italic" shortcut="Mod+I" size="sm" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()} />
          <IconButton icon={Strikethrough} label="Strikethrough" size="sm" active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()} />
          <IconButton icon={Code} label="Inline code" size="sm" active={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()} />
          <IconButton icon={Link2} label="Link" size="sm" active={editor.isActive("link")} onClick={() => void setLink(editor)} />
          <IconButton icon={Heading2} label="Heading" size="sm" active={editor.isActive("heading")} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} />
          <IconButton icon={ListChecks} label="Checklist" size="sm" active={editor.isActive("taskList")} onClick={() => editor.chain().focus().toggleTaskList().run()} />
        </div>
      </BubbleMenu>
      <EditorContent editor={editor} />
      {slash && <SlashMenu editor={editor} state={slash} onPick={(i) => pick(editor, i)} onHover={(i) => setSlash({ ...slash, index: i })} />}
    </>
  );
}

export function InsertMenu({ editor }: { editor: Editor | null }) {
  if (!editor) return null;
  return (
    <Dropdown items={insertItems(editor)} align="end">
      <IconButton icon={Plus} label="Insert block" noTooltip />
    </Dropdown>
  );
}
