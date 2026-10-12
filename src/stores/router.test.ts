import { describe, expect, it } from "vitest";
import { pathOf, routeFromPath } from "./router";

describe("internal routes", () => {
  it("maps /api/accounts both ways", () => {
    expect(routeFromPath("/api/accounts")).toEqual({ name: "api", tab: "accounts" });
    expect(pathOf({ name: "api", tab: "usage" })).toBe("/api/usage");
    expect(routeFromPath("/api/nope")).toBeNull();
  });
});
