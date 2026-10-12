// File-type icons for the project file browser. Recognisable development
// technologies use their Simple Icons mark (monochrome); everything else
// uses a generic Lucide glyph.

import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileLock,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileVideo,
  Folder,
  FolderSymlink,
  type LucideIcon,
} from "lucide-react";
import {
  siAstro,
  siC,
  siCplusplus,
  siCss,
  siDart,
  siDocker,
  siDotnet,
  siGit,
  siGnubash,
  siGo,
  siGraphql,
  siHtml5,
  siJavascript,
  siJson,
  siKotlin,
  siLua,
  siMarkdown,
  siNpm,
  siOpenjdk,
  siPhp,
  siPython,
  siReact,
  siRuby,
  siRust,
  siSass,
  siSqlite,
  siSvelte,
  siSwift,
  siTerraform,
  siToml,
  siTypescript,
  siVite,
  siVuedotjs,
  siYaml,
} from "simple-icons";
import type { FileEntry } from "@/lib/types";
import { BrandIcon, type BrandGlyph } from "@/components/ui/BrandIcon";

const BY_NAME: Record<string, BrandGlyph> = {
  "package.json": siNpm,
  "package-lock.json": siNpm,
  dockerfile: siDocker,
  "docker-compose.yml": siDocker,
  "docker-compose.yaml": siDocker,
  ".gitignore": siGit,
  ".gitattributes": siGit,
  "cargo.toml": siRust,
  "cargo.lock": siRust,
  "vite.config.ts": siVite,
  "vite.config.js": siVite,
};

const BY_EXT: Record<string, BrandGlyph> = {
  ts: siTypescript,
  mts: siTypescript,
  cts: siTypescript,
  tsx: siReact,
  jsx: siReact,
  js: siJavascript,
  mjs: siJavascript,
  cjs: siJavascript,
  rs: siRust,
  py: siPython,
  go: siGo,
  rb: siRuby,
  php: siPhp,
  swift: siSwift,
  kt: siKotlin,
  java: siOpenjdk,
  c: siC,
  h: siC,
  cpp: siCplusplus,
  cc: siCplusplus,
  hpp: siCplusplus,
  cs: siDotnet,
  dart: siDart,
  lua: siLua,
  md: siMarkdown,
  mdx: siMarkdown,
  json: siJson,
  yml: siYaml,
  yaml: siYaml,
  toml: siToml,
  html: siHtml5,
  css: siCss,
  scss: siSass,
  sass: siSass,
  vue: siVuedotjs,
  svelte: siSvelte,
  astro: siAstro,
  graphql: siGraphql,
  gql: siGraphql,
  sqlite: siSqlite,
  db: siSqlite,
  tf: siTerraform,
  sh: siGnubash,
  bash: siGnubash,
};

const GENERIC: [RegExp, LucideIcon][] = [
  [/^(png|jpe?g|gif|webp|bmp|svg|ico|avif|heic|tiff?|psd)$/, FileImage],
  [/^(mp4|mov|mkv|webm|avi|m4v)$/, FileVideo],
  [/^(mp3|wav|flac|ogg|m4a|aac)$/, FileAudio],
  [/^(zip|7z|rar|tar|gz|tgz|bz2|xz)$/, FileArchive],
  [/^(csv|tsv|xlsx?|ods|numbers)$/, FileSpreadsheet],
  [/^(txt|rtf|docx?|odt|pdf|log|pages)$/, FileText],
  [/^(xml|ini|cfg|conf|env|lock|sql|vbs|ps1|psm1|bat|cmd)$/, FileCode],
];

export function FileTypeIcon({ entry, size = 15 }: { entry: Pick<FileEntry, "name" | "isDir" | "isLink" | "program" | "sensitive">; size?: number }) {
  if (entry.isDir) {
    const Icon = entry.isLink ? FolderSymlink : Folder;
    return <Icon size={size} strokeWidth={1.75} className="file-icon file-icon--dir" />;
  }
  if (entry.sensitive) return <FileLock size={size} strokeWidth={1.75} className="file-icon" />;
  const lower = entry.name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const brand = BY_NAME[lower] ?? BY_EXT[ext];
  if (brand) return <BrandIcon icon={brand} size={size - 2} className="file-icon file-icon--brand" />;
  if (entry.program) return <FileTerminal size={size} strokeWidth={1.75} className="file-icon" />;
  const generic = GENERIC.find(([re]) => re.test(ext))?.[1] ?? File;
  const Icon = generic;
  return <Icon size={size} strokeWidth={1.75} className="file-icon" />;
}
