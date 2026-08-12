import { buildDeviceForm, findClash } from "./device-management-helpers";

// t() only needs to return the key so findClash's branch and the form labels stay visible.
vi.mock("./lib/i18n", () => ({ t: (k: string) => k }));

describe("findClash", () => {
  const rows = [
    { name: "Living room", ip: "192.168.1.10" },
    { name: "Kitchen", ip: "192.168.1.11" },
  ];

  it("flags a duplicate ip", () => {
    expect(findClash(rows, { name: "New", ip: "192.168.1.11" }, -1)).toBe("invalidIp");
  });

  it("returns null when the ip is new and valid", () => {
    expect(findClash(rows, { name: "New", ip: "192.168.1.12" }, -1)).toBeNull();
  });

  it("excludes the edited row so its own ip does not clash with itself", () => {
    expect(findClash(rows, { name: "Living room", ip: "192.168.1.10" }, 0)).toBeNull();
  });

  it("rejects a malformed ip", () => {
    expect(findClash(rows, { name: "New", ip: "not-an-ip" }, -1)).toBe("invalidIp");
  });

  it("rejects a name that maps to the reserved 'info' object id", () => {
    expect(findClash(rows, { name: "info", ip: "192.168.1.12" }, -1)).toBe("invalidIp");
  });

  it("rejects a different name that sanitizes to the same id as another row", () => {
    // "Living room" and "Living*room" both sanitize to "Living_room": distinct names, same tree.
    expect(findClash(rows, { name: "Living*room", ip: "192.168.1.12" }, -1)).toBe("invalidIp");
  });

  it("falls back to the ip as the id when the name is blank", () => {
    expect(findClash(rows, { name: "", ip: "192.168.1.12" }, -1)).toBeNull();
  });
});

describe("buildDeviceForm", () => {
  it("builds a name + ip panel and embeds the used ips into the ip validator", () => {
    const form = buildDeviceForm(["192.168.1.10"]) as unknown as {
      type: string;
      items: { name: { type: string }; ip: { type: string; validator: string } };
    };
    expect(form.type).toBe("panel");
    expect(form.items.name.type).toBe("text");
    expect(form.items.ip.type).toBe("text");
    // the already-used ip must be part of the "not in use" validator expression
    expect(form.items.ip.validator).toContain("192.168.1.10");
  });
});
