import { describe, expect, it } from "vitest";
import { normaliseApiBase, resolveMode } from "@/lib/config";

describe("mode", () => {
  it("demo is never on in a production build unless explicitly enabled", () => {
    expect(resolveMode({ nodeEnv: "production" })).toBe("unconfigured");
    expect(resolveMode({ nodeEnv: "production", demoMode: "true" })).toBe("demo");
    expect(resolveMode({ nodeEnv: "production", demoMode: "1" })).toBe("unconfigured");
  });
  it("live when an API base is set", () => {
    expect(resolveMode({ nodeEnv: "production", apiBase: "https://x/api" })).toBe("live");
    expect(resolveMode({ nodeEnv: "development", apiBase: "https://x/api" })).toBe("live");
  });
  it("development without an API base runs the demo", () => {
    expect(resolveMode({ nodeEnv: "development" })).toBe("demo");
  });
  it("normalises the base", () => {
    expect(normaliseApiBase(" https://x/api/ ")).toBe("https://x/api");
  });
});
