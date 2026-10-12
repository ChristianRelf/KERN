import { describe, expect, it } from "vitest";
import { slugify, suggestBranchName, uniqueBranch } from "./branches";
import { joinArgs, splitArgs } from "./args";

describe("branch names", () => {
  it("suggests readable, git-safe names", () => {
    expect(suggestBranchName("Fix reactor cooling controls")).toBe("fix/reactor-cooling-controls");
    expect(suggestBranchName("Reactor cooling controls")).toBe("feature/reactor-cooling-controls");
    expect(suggestBranchName("Reactor cooling controls", 124)).toBe("feature/124-reactor-cooling-controls");
    expect(suggestBranchName("Cooling", 7, ["bug"])).toBe("fix/7-cooling");
    expect(slugify("Ünïcode — and the ~weird~ chars!")).toBe("unicode-weird-chars");
    expect(slugify("!!!")).toBe("work");
  });

  it("never reuses a taken name", () => {
    const taken = new Set(["feature/x", "feature/x-2"]);
    expect(uniqueBranch("feature/x", taken)).toBe("feature/x-3");
    expect(uniqueBranch("feature/y", taken)).toBe("feature/y");
  });
});

describe("command arguments", () => {
  it("splits quoted arguments without a shell", () => {
    expect(splitArgs(`run dev -- --port 3000`)).toEqual(["run", "dev", "--", "--port", "3000"]);
    expect(splitArgs(`build "my file.txt" ''`)).toEqual(["build", "my file.txt", ""]);
    expect(splitArgs(`a && rm -rf /`)).toEqual(["a", "&&", "rm", "-rf", "/"]);
    expect(splitArgs(joinArgs(["x y", "z"]))).toEqual(["x y", "z"]);
  });
});
