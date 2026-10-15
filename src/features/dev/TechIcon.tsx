/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Monochrome marks for detected technologies (Simple Icons where one
// exists, a Lucide glyph otherwise). Kept small and greyscale on purpose.

import { Blocks, Box, Cog, Cpu, FileCode, Gamepad2, Hammer, Layers, Package, type LucideIcon } from "lucide-react";
import {
  siAngular,
  siApachemaven,
  siAstro,
  siBun,
  siCmake,
  siDeno,
  siDjango,
  siDocker,
  siDotnet,
  siElectron,
  siExpress,
  siFastapi,
  siFlask,
  siGnu,
  siGo,
  siGradle,
  siJavascript,
  siKotlin,
  siNextdotjs,
  siNodedotjs,
  siNpm,
  siOpenjdk,
  siPnpm,
  siPoetry,
  siPython,
  siReact,
  siRoblox,
  siRust,
  siSvelte,
  siTailwindcss,
  siTauri,
  siTypescript,
  siUnity,
  siUnrealengine,
  siUv,
  siVite,
  siVuedotjs,
  siYarn,
} from "simple-icons";
import { BrandIcon, type BrandGlyph } from "@/components/ui/BrandIcon";

const BRANDS: Record<string, BrandGlyph> = {
  angular: siAngular,
  apachemaven: siApachemaven,
  astro: siAstro,
  bun: siBun,
  cmake: siCmake,
  deno: siDeno,
  django: siDjango,
  docker: siDocker,
  "docker-compose": siDocker,
  dotnet: siDotnet,
  electron: siElectron,
  express: siExpress,
  fastapi: siFastapi,
  flask: siFlask,
  make: siGnu,
  go: siGo,
  gradle: siGradle,
  javascript: siJavascript,
  kotlin: siKotlin,
  nextdotjs: siNextdotjs,
  nodejs: siNodedotjs,
  npm: siNpm,
  openjdk: siOpenjdk,
  pnpm: siPnpm,
  poetry: siPoetry,
  python: siPython,
  pip: siPython,
  venv: siPython,
  react: siReact,
  roblox: siRoblox,
  rust: siRust,
  cargo: siRust,
  "cargo-workspace": siRust,
  svelte: siSvelte,
  tailwindcss: siTailwindcss,
  tauri: siTauri,
  typescript: siTypescript,
  unity: siUnity,
  unrealengine: siUnrealengine,
  uv: siUv,
  vite: siVite,
  vuedotjs: siVuedotjs,
  yarn: siYarn,
};

const FALLBACK: Record<string, LucideIcon> = {
  rojo: Blocks,
  "package-manager": Package,
  engine: Gamepad2,
  runtime: Cpu,
  framework: Layers,
  tool: Hammer,
  language: FileCode,
};

export function TechIcon({ id, kind, size = 14 }: { id: string; kind?: string; size?: number }) {
  const brand = BRANDS[id];
  if (brand) return <BrandIcon icon={brand} size={size} className="tech-icon" />;
  const Icon = FALLBACK[id] ?? (kind ? FALLBACK[kind] : undefined) ?? (kind === undefined ? Cog : Box);
  return <Icon size={size} strokeWidth={1.75} className="tech-icon" />;
}
