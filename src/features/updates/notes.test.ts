import { describe, expect, it } from "vitest";
import { compareVersions, inAppNotes } from "./notes";

describe("compareVersions", () => {
  it("compares numerically, not as text", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
    expect(compareVersions("v0.1.9", "0.1.9")).toBe(0);
    expect(compareVersions("0.2.0", "0.10.0")).toBe(-1);
  });
  it("puts a pre-release before its release", () => {
    expect(compareVersions("0.2.0-beta", "0.2.0")).toBe(-1);
    expect(compareVersions("0.2.0", "0.2.0-beta")).toBe(1);
    expect(compareVersions("0.2.0-alpha", "0.2.0-beta")).toBe(-1);
  });
});

describe("inAppNotes", () => {
  const body = [
    "## What's new",
    "",
    "### Task relations",
    "- Blocked by",
    "",
    "### Fixes",
    "- Board fix",
    "",
    "## Install",
    "- **Windows x64:** setup.exe",
    "- **Linux:** later",
  ].join("\r\n");

  it("drops the leading heading and the install section", () => {
    expect(inAppNotes(body)).toBe("### Task relations\n- Blocked by\n\n### Fixes\n- Board fix");
  });

  it("keeps sections after the install section", () => {
    expect(inAppNotes("## Install\nx\n## Thanks\nYou")).toBe("## Thanks\nYou");
  });

  it("leaves other notes alone", () => {
    expect(inAppNotes("Small fixes.")).toBe("Small fixes.");
  });
});
