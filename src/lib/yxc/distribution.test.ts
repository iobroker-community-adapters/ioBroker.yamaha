import { distributionSummary, parseYxcDistribution } from "./distribution";

describe("parseYxcDistribution", () => {
  test("maps getDistributionInfo to the read-only multiroom states", () => {
    expect(
      parseYxcDistribution({
        group_id: "abc",
        group_name: "Kitchen",
        role: "server",
        server_zone: "main",
        client_list: ["1.2.3.5"],
      }),
    ).toEqual([
      { id: "multiroom.group.role", value: "server" },
      // Only a server of API 2.00 reports a construction state — none here, not a word outside its list.
      { id: "multiroom.group.status", value: null },
      { id: "multiroom.group.id", value: "abc" },
      { id: "multiroom.group.name", value: "Kitchen" },
      { id: "multiroom.group.serverZone", value: "main" },
      { id: "multiroom.group.linkedDevices", value: '["1.2.3.5"]' },
    ]);
  });

  test("returns an empty list for a malformed response", () => {
    expect(parseYxcDistribution(null)).toEqual([]);
  });

  // YXC Advanced §9.2 and §9.1.7-5: the role word alone flickers; the group id and the roster decide
  // (audit 2026-09-24, C7). The roster arrives as objects since §5.1 ({ip_address, data_type}).
  test("the effective role comes from the group id and the roster, not from the role word", () => {
    const group = "9A237BF5AB80ED3C7251DFF49825CA42";
    expect(
      distributionSummary({ role: "none", group_id: group, client_list: [{ ip_address: "10.0.0.7" }] }),
    ).toMatchObject({
      role: "server",
      inGroup: true,
      clients: ["10.0.0.7"],
    });
    expect(distributionSummary({ role: "client", group_id: "" }).role).toBe("none");
    expect(distributionSummary({ role: "client", group_id: "00000000000000000000000000000000" }).role).toBe("none");
    expect(distributionSummary({ role: "client", group_id: group }).role).toBe("client");
    expect(
      distributionSummary({ role: "server", group_id: group, client_list: ["10.0.0.7"], status: " working " }).status,
    ).toBe("working");
    expect(distributionSummary({ role: "client", group_id: group, status: "working" }).status).toBeUndefined();
  });
});
