import { XML_BROWSE_SOURCES } from "./xml-browse-driver";
import { YNCA_BROWSE_SOURCES } from "./ynca-browse-driver";
import { YXC_BROWSE_SOURCES } from "./yxc-browse-driver";

// `player.browse.source` offers each transport's keys; the owner of the datapoint depends on the device,
// so one source must carry one key everywhere — MusicCast called SiriusXM `sirius`, YNCA `siriusXm`
// (audit 2026-09-29, D5).
describe("the browse sources of the three transports", () => {
  test("a source has the same key on every transport that offers it", () => {
    const byLabel = new Map<string, Set<string>>();
    for (const source of [...YNCA_BROWSE_SOURCES, ...YXC_BROWSE_SOURCES, ...XML_BROWSE_SOURCES]) {
      byLabel.set(source.label, (byLabel.get(source.label) ?? new Set()).add(source.key));
    }
    const split = [...byLabel]
      .filter(([, keys]) => keys.size > 1)
      .map(([label, keys]) => `${label}: ${[...keys].join(", ")}`);
    expect(split).toEqual([]);
  });

  test("XML offers every source whose desc.xml declares the list form", () => {
    expect(XML_BROWSE_SOURCES.map(source => source.element)).toEqual(
      expect.arrayContaining([
        "NET_RADIO",
        "SERVER",
        "USB",
        "iPod_USB",
        "JUKE",
        "Napster",
        "Pandora",
        "Rhapsody",
        "SiriusXM",
      ]),
    );
  });
});
