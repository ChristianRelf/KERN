import { describe, expect, it } from "vitest";
import { slug } from "./push";

describe("branch slugs", () => {
  it("makes readable branch names", () => {
    expect(slug("Fix login bug!")).toBe("fix-login-bug");
    expect(slug("  Call   supplier - today ")).toBe("call-supplier-today");
  });
});
