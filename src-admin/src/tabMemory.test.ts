import { describe, expect, it } from "vitest";
import { forgetLastTab } from "./tabMemory";

describe("forgetLastTab", () => {
  it("removes this adapter's remembered tab, and nothing else", () => {
    localStorage.clear();
    localStorage.setItem("App.yamaha", "_expert");
    localStorage.setItem("Other.yamaha", "_main");
    localStorage.setItem("App.govee-smart", "_expert");
    localStorage.setItem("App.yamaha-not", "_main");
    forgetLastTab("yamaha.0");
    expect(localStorage.getItem("App.yamaha")).toBeNull();
    expect(localStorage.getItem("Other.yamaha")).toBeNull();
    expect(localStorage.getItem("App.govee-smart")).toBe("_expert");
    expect(localStorage.getItem("App.yamaha-not")).toBe("_main");
  });

  it("works with the admin's server-synced storage, which cannot be enumerated", () => {
    const store: Record<string, string> = { "App.yamaha": "_expert" };
    (window as unknown as { _localStorage: unknown })._localStorage = {
      getItem: (k: string) => store[k] ?? null,
      removeItem: (k: string) => delete store[k],
    };
    forgetLastTab("yamaha.0");
    expect(store).toEqual({});
    delete (window as unknown as { _localStorage?: unknown })._localStorage;
  });
});
