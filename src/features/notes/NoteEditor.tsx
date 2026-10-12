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
} from "lucide-react";
import { useEffect, useRef } from "react";
import { IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Menu";
import { prompt } from "@/components/ui/Dialog";
import { api } from "@/lib/ipc";

function getMarkdown(editor: Editor): string {
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

/**
 * Markdown-backed rich text editor. Content is stored as Markdown (portable);
 * typing Markdown syntax formats inline. Changes are reported via onChange
 * (debounced by the caller) and flushed on unmount.
 */
export function NoteEditor({
  initial,
  onChange,
  onFlush,
  placeholder = "Start writing… Markdown shortcuts work: #, -, [ ], ```, **bold**",
  autoFocus,
  onEditor,
}: {
  initial: string;
  onChange: (markdown: string) => void;
  onFlush?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  onEditor?: (e: Editor | null) => void;
}) {
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
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
      attributes: { class: "prose", spellcheck: "true" },
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
  });

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
