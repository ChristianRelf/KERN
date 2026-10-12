import { describe, expect, it } from "vitest";
import { displayUrl, extractUrls, originOf } from "./links";

describe("links", () => {
  it("extracts urls from prose without trailing punctuation", () => {
    expect(extractUrls("See https://github.com/a/b. Also (https://x.dev/docs) and https://github.com/a/b again")).toEqual([
      "https://github.com/a/b",
      "https://x.dev/docs",
    ]);
  });
  it("formats readable urls", () => {
    expect(displayUrl("https://www.github.com/example/project/")).toBe("github.com/example/project");
    expect(displayUrl("github.com/x?y=1")).toBe("github.com/x?…");
  });
  it("only gives web origins", () => {
    expect(originOf("https://GitHub.com/x")).toBe("https://github.com");
    expect(originOf("file:///C:/secret")).toBeNull();
    expect(originOf("mailto:a@b.c")).toBeNull();
  });
});
