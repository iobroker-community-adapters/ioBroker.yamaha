import { XmlClient } from "./xml-client";

describe("XmlClient", () => {
  test("send posts a PUT envelope to the control endpoint", async () => {
    const posts: Array<{ ip: string; body: string }> = [];
    const client = new XmlClient("1.2.3.4", async (ip, body) => {
      posts.push({ ip, body });
      return "";
    });
    await client.send("Main_Zone", "<Power_Control><Power>On</Power></Power_Control>");
    expect(posts).toEqual([
      {
        ip: "1.2.3.4",
        body: '<YAMAHA_AV cmd="PUT"><Main_Zone><Power_Control><Power>On</Power></Power_Control></Main_Zone></YAMAHA_AV>',
      },
    ]);
  });

  test("getStatus posts a Basic_Status GET and parses the response", async () => {
    const client = new XmlClient(
      "1.2.3.4",
      async () =>
        "<YAMAHA_AV><Main_Zone><Basic_Status><Power_Control><Power>On</Power></Power_Control></Basic_Status></Main_Zone></YAMAHA_AV>",
    );
    expect(await client.getStatus("Main_Zone")).toEqual({ power: true });
  });
});
