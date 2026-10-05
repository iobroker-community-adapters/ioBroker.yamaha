import { randomBytes } from "node:crypto";
import type { ControllerLog } from "../controller";
import { errText } from "../err-text";
import type { CommandGate } from "../lifecycle/command-gate";
import type { WriteOutcome } from "../lifecycle/multi-transport-handle";
import { resolveIPv4 } from "../network-interfaces";
import { parseYxcFeatures, type YxcCapabilities } from "./capability";
import type { YxcClientLike } from "./client-contract";
import { distributionSummary, type DistributionSummary } from "./distribution";
import { answeredByDevice } from "./http-client";

/** How often, and how far apart, a new group is read back until it works (YXC Advanced §9.1.8-3: up to 3 min). */
const GROUP_BUILD_POLLS = 36;
const GROUP_BUILD_POLL_MS = 5000;

/** The longest group name the device takes, in UTF-8 bytes (YXC Advanced §5.6). */
const GROUP_NAME_MAX_BYTES = 128;

/** What a group change needs from its controller. */
export interface LinkGroupDeps {
  /** The id-safe device id, for the log lines. */
  deviceId: string;
  /** This device's client. */
  client: YxcClientLike;
  /** Resolve another configured device's client by its address. */
  clientFor?: (ip: string) => YxcClientLike | undefined;
  /** The addresses of the other configured devices. */
  partnerIps?: () => readonly string[];
  /** The device's address as configured — its own address in a server's roster. */
  host?: string;
  /** The device's command gate: its pacing for the build read-back, its shutdown flag. */
  gate: CommandGate;
  /** Adapter log. */
  log: ControllerLog;
  /** Re-read this device's distribution (its datapoints follow) and say what it is now. */
  refresh(): Promise<DistributionSummary>;
  /** What the last distribution read said about this device's group. */
  summary(): DistributionSummary;
  /** The MusicCast Link this device declares (getFeatures `distribution`). */
  features(): YxcCapabilities["distribution"];
}

/**
 * The MusicCast Link group of one device (YXC Advanced §9.1): link a client, leave, rename, and the leave a client
 * owes once its input left MusicCast Link — out of the 2.4k-line controller (review 2026-10-05, D).
 *
 * Every change waits in ONE queue for the one before it. Unqueued, two quick `multiroom.group.linkDevice` writes
 * (a script linking kitchen and bath) both read "no group yet" and each drew its own random group id: the kitchen
 * ended in an orphaned group, and the build was polled for three minutes without a word. Leave and link raced the
 * same way (review 2026-10-05, A14). A link holds the queue until its group works (§9.1.8-3, up to three minutes) —
 * the device answers a change during the build with "Linking in progress" (response code 200, Advanced §6) — while
 * the write itself is answered as soon as the commands went through.
 */
export class LinkGroup {
  /** The end of the queue: the next change starts once this settles. */
  private tail: Promise<void> = Promise.resolve();

  /**
   * @param deps the controller's client, partners, gate and distribution read
   */
  public constructor(private readonly deps: LinkGroupDeps) {}

  /**
   * Form or extend a group with this device as server (YXC Advanced §9.1): check the two are compatible (§9.1.1),
   * give the client the group, the server's address and the MusicCast Link input (§5.3, §9.1.6), add it to the
   * roster, start the distribution with the network's distribution number (§5.4), and read the group back until it
   * is working (§9.1.8-3). A group this device already serves is extended, not replaced; a new one gets a random id
   * (§9.1.2) (audit 2026-09-24, C7).
   *
   * @param target the address of the client device (a configured device)
   * @returns what the devices made of it
   */
  public link(target: string): Promise<WriteOutcome> {
    return this.enqueue(hold => this.linkNow(target, hold));
  }

  /**
   * Leave the current group (YXC Advanced §9.1): a server stops distributing and clears its server setup (§5.5,
   * §5.2 with group ""), and releases its configured clients (§9.1.3-1); a client leaves as {@link leaveAsClient}.
   * Decided on the EFFECTIVE role (§9.2) — the role word flickers (audit 2026-09-24, C7).
   *
   * @returns what the devices made of it
   */
  public leave(): Promise<WriteOutcome> {
    return this.enqueue(() => this.leaveNow());
  }

  /**
   * Name the group (YXC Advanced §5.6): UTF-8 within 128 bytes, "" restores the default; then read the distribution
   * back, so the datapoint shows what the device took (audit 2026-09-24, C8).
   *
   * @param value the written name
   * @returns what the device made of it
   */
  public rename(value: unknown): Promise<WriteOutcome> {
    return this.enqueue(() => this.renameNow(value));
  }

  /**
   * A zone left the MusicCast Link input while this device is a client: it has to leave the group (YXC Advanced
   * §9.1.6-1). Queued like a user's change; by the time it runs, a change before it may already have left.
   */
  public leaveAfterInputChange(): void {
    void this.enqueue(() => this.leaveAfterInput());
  }

  /**
   * Run one change after the one before it has finished — and after what that one holds the queue for.
   *
   * @param task the change; `hold` keeps the queue waiting for work that goes on after its answer
   * @returns the change's outcome
   */
  private enqueue(task: (hold: (work: Promise<void>) => void) => Promise<WriteOutcome>): Promise<WriteOutcome> {
    let held: Promise<void> = Promise.resolve();
    const outcome = this.tail.then(() =>
      // A change still queued when the connection closed goes nowhere.
      this.deps.gate.closed
        ? "unavailable"
        : task(work => {
            held = work;
          }),
    );
    this.tail = outcome
      .then(() => held)
      .then(
        () => undefined,
        () => undefined,
      );
    return outcome.catch((e: unknown) => {
      this.deps.log.warn(`${this.deps.deviceId}: a group change failed: ${errText(e)}`);
      return "unavailable" as const;
    });
  }

  /**
   * Link one client now (see {@link link}).
   *
   * @param target the address of the client device
   * @param hold keeps the queue waiting for the group build
   * @returns what the devices made of it
   */
  private async linkNow(target: string, hold: (work: Promise<void>) => void): Promise<WriteOutcome> {
    const { client, deviceId, log } = this.deps;
    try {
      const clientIp = (await resolveIPv4(target)) ?? target;
      const partner = this.deps.clientFor?.(clientIp) ?? this.deps.clientFor?.(target);
      if (!partner) {
        log.warn(`${deviceId}: cannot link ${target} — not a known device`);
        return "unavailable";
      }
      const master = this.deps.features();
      const joiningFeatures = parseYxcFeatures(await partner.getFeatures());
      const joining = joiningFeatures.distribution;
      // Zone A and Zone B join a group only together (YXC Advanced §9.1.7-2).
      const joiningZones = joiningFeatures.zones.some(zone => zone.id === "zone2" && zone.zoneB === true)
        ? ["main", "zone2"]
        : ["main"];
      if (master?.compatibleClients !== undefined) {
        // No `version` means a 1.x network module (YXC Advanced §9.1.8-1/-2) — it was let through
        // unchecked and the build failed silently after three minutes of polling (audit 2026-09-29, C43).
        const version = joining?.version ?? 1;
        if (!master.compatibleClients.includes(Math.floor(version))) {
          log.warn(
            `${deviceId}: cannot link ${target} — its MusicCast Link version ${version} is not one this device takes (${master.compatibleClients.join(", ")}); a firmware update of either brings them together`,
          );
          return "unavailable";
        }
      }
      const dist = await this.deps.refresh();
      const num = await this.networkClientCount(dist);
      const groupId =
        dist.role === "server" && dist.inGroup ? dist.groupId : randomBytes(16).toString("hex").toUpperCase();
      const serverIp = await this.ownIp();
      await partner.setClientInfo({
        group_id: groupId,
        zone: joiningZones,
        ...(serverIp !== undefined ? { server_ip_address: serverIp } : {}),
      });
      for (const zone of joiningZones) {
        await partner.setInput("mc_link", zone);
      }
      await client.setServerInfo({ group_id: groupId, zone: "main", type: "add", client_list: [clientIp] });
      await client.startDistribution(num);
      hold(this.awaitGroupBuilt());
      return "sent";
    } catch (e) {
      // A user action failing must be visible — warn, like every other write command.
      log.warn(`${deviceId}: linkClient(${target}) failed: ${errText(e)}`);
      return answeredByDevice(e) ? "refused" : "unavailable";
    }
  }

  /**
   * Leave the group now (see {@link leave}).
   *
   * @returns what the devices made of it
   */
  private async leaveNow(): Promise<WriteOutcome> {
    const { client } = this.deps;
    try {
      const dist = await this.deps.refresh();
      if (dist.role === "server") {
        await client.stopDistribution();
        await client.setServerInfo({ group_id: "" });
        // The clients are released too (YXC Advanced §9.1.3-1): before, they kept the group id and the
        // MusicCast Link input (audit 2026-09-29, C43). A client this adapter does not run is left
        // alone — it notices the lost server itself.
        for (const ip of this.deps.partnerIps?.() ?? []) {
          const partner = this.deps.clientFor?.(ip);
          if (partner && dist.clients.includes((await resolveIPv4(ip)) ?? ip)) {
            await partner.setClientInfo({ group_id: "" });
          }
        }
      } else if (dist.role === "client") {
        await this.leaveAsClient(dist);
      } else {
        await client.setClientInfo({ group_id: "" });
      }
      await this.deps.refresh();
      return "sent";
    } catch (e) {
      // A user action failing must be visible — warn, like every other write command.
      this.deps.log.warn(`${this.deps.deviceId}: leaveGroup failed: ${errText(e)}`);
      return answeredByDevice(e) ? "refused" : "unavailable";
    }
  }

  /**
   * Rename the group now (see {@link rename}).
   *
   * @param value the written name
   * @returns what the device made of it
   */
  private async renameNow(value: unknown): Promise<WriteOutcome> {
    const { deviceId, log } = this.deps;
    let outcome: WriteOutcome = "unavailable";
    try {
      const name = typeof value === "string" ? value : undefined;
      if (name === undefined) {
        log.debug(`${deviceId}: a group name is text — ${typeof value} not sent`);
      } else if (Buffer.byteLength(name, "utf8") > GROUP_NAME_MAX_BYTES) {
        log.debug(`${deviceId}: group name "${name}" is longer than ${GROUP_NAME_MAX_BYTES} bytes — not sent`);
      } else {
        await this.deps.client.setGroupName(name);
        outcome = "sent";
      }
    } catch (e) {
      log.warn(`${deviceId}: renaming the group failed: ${errText(e)}`);
      outcome = answeredByDevice(e) ? "refused" : "unavailable";
    }
    // The device's name again — the one it took, or the one it kept.
    await this.deps.refresh();
    return outcome;
  }

  /**
   * Leave as a client after the input change (see {@link leaveAfterInputChange}).
   *
   * @returns what the devices made of it
   */
  private async leaveAfterInput(): Promise<WriteOutcome> {
    const { deviceId, log } = this.deps;
    const dist = this.deps.summary();
    if (dist.role !== "client") {
      log.debug(
        `${deviceId}: the input left MusicCast Link, and the device is in no group any more — nothing to leave`,
      );
      return "sent";
    }
    try {
      log.debug(`${deviceId}: the input left MusicCast Link — leaving the group`);
      await this.leaveAsClient(dist);
      await this.deps.refresh();
      return "sent";
    } catch (e) {
      log.warn(`${deviceId}: leaving the group after the input change failed: ${errText(e)}`);
      return answeredByDevice(e) ? "refused" : "unavailable";
    }
  }

  /**
   * Leave a group as a client (YXC Advanced §9.1.3): clear this device's client setup, then take it off its
   * server's roster and — where clients remain — restart the distribution with the network's distribution number.
   * The server is found among the configured devices; one this adapter does not know is left alone (it drops the
   * client when it stops answering).
   *
   * @param dist what the device's last distribution read said
   */
  private async leaveAsClient(dist: DistributionSummary): Promise<void> {
    const ownIp = await this.ownIp();
    const num = await this.networkClientCount(dist);
    await this.deps.client.setClientInfo({ group_id: "" });
    if (ownIp === undefined) {
      return;
    }
    for (const ip of this.deps.partnerIps?.() ?? []) {
      const partner = this.deps.clientFor?.(ip);
      const summary = partner ? await this.summaryOf(partner) : undefined;
      if (!partner || summary?.role !== "server" || !summary.clients.includes(ownIp)) {
        continue;
      }
      await partner.setServerInfo({
        group_id: summary.groupId,
        zone: summary.serverZone,
        type: "remove",
        client_list: [ownIp],
      });
      if (summary.clients.length > 1) {
        await partner.startDistribution(num);
      } else {
        // The last client gone: "If all clients are to be removed, set empty text to GroupID in
        // setServerInfo" (YXC Advanced §9.1.3-2) — the server showed "server" with an empty roster (C43).
        await partner.setServerInfo({ group_id: "" });
      }
      return;
    }
    this.deps.log.debug(`${this.deps.deviceId}: the group's server is not a configured device — left its roster to it`);
  }

  /** Read the distribution until the group reports `working` — at most three minutes (§9.1.8-3). */
  private async awaitGroupBuilt(): Promise<void> {
    const gate = this.deps.gate;
    let dist = await this.deps.refresh();
    for (let round = 0; round < GROUP_BUILD_POLLS; round++) {
      if (dist.status === undefined || dist.status === "working") {
        return;
      }
      await gate.delay(GROUP_BUILD_POLL_MS);
      if (gate.closed) {
        return;
      }
      dist = await this.deps.refresh();
    }
  }

  /**
   * This device's IPv4 address, for a server's roster (`client_list` and `server_ip_address` take addresses, YXC
   * Advanced §5.2/§5.3).
   *
   * @returns the address, or undefined when the configured host does not resolve
   */
  private async ownIp(): Promise<string | undefined> {
    return this.deps.host === undefined ? undefined : resolveIPv4(this.deps.host);
  }

  /**
   * A device's group summary, or undefined when it does not answer.
   *
   * @param client the device's client
   * @returns its summary
   */
  private async summaryOf(client: YxcClientLike): Promise<DistributionSummary | undefined> {
    try {
      return distributionSummary(await client.getDistributionInfo());
    } catch (e) {
      this.deps.log.debug(`${this.deps.deviceId}: a partner's getDistributionInfo failed: ${errText(e)}`);
      return undefined;
    }
  }

  /**
   * The distribution number of the MusicCast network BEFORE a change: how many clients every server among the
   * configured devices distributes to — `startDistribution?num=` (YXC Advanced §5.4, §9.1.2–§9.1.5: the first
   * group 0, a third client joining a group of two 2). It was a fixed 0.
   *
   * @param dist what this device's distribution read said
   * @returns the number
   */
  private async networkClientCount(dist: DistributionSummary): Promise<number> {
    let count = dist.role === "server" ? dist.clients.length : 0;
    for (const ip of this.deps.partnerIps?.() ?? []) {
      const partner = this.deps.clientFor?.(ip);
      const summary = partner ? await this.summaryOf(partner) : undefined;
      if (summary?.role === "server") {
        count += summary.clients.length;
      }
    }
    return count;
  }
}
