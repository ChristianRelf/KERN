import { describe, expect, it } from "vitest";
import { SYNTAXES, GRAMMAR_META } from "./catalog";
import { suggestSyntaxes, syntaxForFile } from "./syntax";

describe("syntaxForFile", () => {
  it("matches names before extensions", () => {
    expect(syntaxForFile("main.ts")?.id).toBe("typescript");
    expect(syntaxForFile("App.TSX")?.id).toBe("tsx");
    expect(syntaxForFile("Dockerfile")?.id).toBe("docker");
    expect(syntaxForFile("tsconfig.json")?.id).toBe("jsonc");
    expect(syntaxForFile("package.json")?.id).toBe("json");
    expect(syntaxForFile(".env.local")?.id).toBe("dotenv");
    expect(syntaxForFile("photo.png")).toBeUndefined();
  });
});

describe("suggestSyntaxes", () => {
  const kinds = [
    { key: "ts", count: 214 },
    { key: "tsx", count: 40 },
    { key: "json", count: 30 },
    { key: "css", count: 1 },
    { key: "dockerfile", count: 1 },
  ];
  it("suggests code languages the project uses, most files first", () => {
    expect(suggestSyntaxes(kinds, [], []).map((s) => [s.syntax.id, s.files])).toEqual([
      ["typescript", 214],
      ["tsx", 40],
    ]);
  });
  it("skips installed and declined languages", () => {
    expect(suggestSyntaxes(kinds, ["typescript"], ["tsx"])).toEqual([]);
  });
});

describe("catalog", () => {
  it("has grammar metadata for every grammar a plugin installs", () => {
    for (const s of SYNTAXES) for (const g of [s.id, ...s.requires]) expect(GRAMMAR_META[g], g).toBeDefined();
  });
});
