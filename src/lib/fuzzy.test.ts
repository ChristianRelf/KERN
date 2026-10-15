/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore } from "./fuzzy";

describe("fuzzy", () => {
  it("matches subsequences and rejects non-matches", () => {
    expect(fuzzyScore("ctsk", "Create task")).not.toBeNull();
    expect(fuzzyScore("xyz", "Create task")).toBeNull();
  });

  it("ranks prefix and word-start matches first", () => {
    const items = ["Open settings", "Toggle sidebar", "Settings: Appearance", "Reset"];
    expect(fuzzyFilter(items, "set", (s) => s)[0]).toBe("Settings: Appearance");
    expect(fuzzyFilter(items, "tog", (s) => s)[0]).toBe("Toggle sidebar");
  });

  it("uses keywords as a weaker signal", () => {
    const items = [
      { t: "Open Inbox", k: "capture unsorted" },
      { t: "Open Notes", k: "" },
    ];
    expect(fuzzyFilter(items, "unsorted", (i) => i.t, (i) => i.k)[0].t).toBe("Open Inbox");
  });
});
