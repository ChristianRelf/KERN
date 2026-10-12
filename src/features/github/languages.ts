// Language colours for the repository language bar: GitHub's own (from
// linguist) so they read familiar, softened in CSS. Unknown languages fall
// back to the muted series hues.

const LINGUIST: Record<string, string> = {
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Rust: "#dea584",
  Python: "#3572a5",
  Go: "#00add8",
  Java: "#b07219",
  Kotlin: "#a97bff",
  Swift: "#f05138",
  "C#": "#178600",
  C: "#555555",
  "C++": "#f34b7d",
  Ruby: "#701516",
  PHP: "#4f5d95",
  Dart: "#00b4ab",
  Lua: "#000080",
  Shell: "#89e051",
  PowerShell: "#012456",
  HTML: "#e34c26",
  CSS: "#663399",
  SCSS: "#c6538c",
  Vue: "#41b883",
  Svelte: "#ff3e00",
  Astro: "#ff5a03",
  MDX: "#fcb32c",
  Dockerfile: "#384d54",
  HCL: "#844fba",
  Nix: "#7e7eff",
  Elixir: "#6e4a7e",
  Haskell: "#5e5086",
  Scala: "#c22d40",
  Zig: "#ec915c",
  "Objective-C": "#438eff",
  "Jupyter Notebook": "#da5b0b",
  Makefile: "#427819",
  NSIS: "#555555",
};

export function languageColor(name: string, index: number): string {
  return LINGUIST[name] ?? `var(--hue-${index % 8})`;
}
