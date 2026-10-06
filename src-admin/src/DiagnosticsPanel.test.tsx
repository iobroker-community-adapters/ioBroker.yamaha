import React from "react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@iobroker/gui-components", () => ({
  I18n: { t: (key: string, ...args: unknown[]) => [key, ...args].join(" ") },
}));

import { DiagnosticsPanel } from "./DiagnosticsPanel";

/** The card asks every few milliseconds here, not every two seconds. */
const FAST = { listMs: 15_000, exportMs: 180_000, pollMs: 5 };

/**
 * An instance that lists its devices, starts a report as job `j1` and hands back `answers.export` for it.
 *
 * @param answers the device list and the report (or error)
 * @param answers.list the answer to `list`
 * @param answers.export the answer to `result`
 */
function socket(answers: { list: unknown; export?: unknown }): { sendTo: ReturnType<typeof vi.fn> } {
  return {
    sendTo: vi.fn((_instance: string, _command: string, data: { action: string }) =>
      Promise.resolve(data.action === "list" ? answers.list : data.action === "start" ? { job: "j1" } : answers.export),
    ),
  };
}

describe("DiagnosticsPanel", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:report");
    URL.revokeObjectURL = vi.fn();
  });

  it("pre-selects the only device and downloads the report under the adapter's file name", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const s = socket({
      list: { devices: [{ value: "rx-v6a-2b3c", label: "RX-V6A", connected: true }] },
      export: { fileName: "yamaha_rx-v6a-2b3c_v3.3.0.json", content: "{}" },
    });
    render(
      <DiagnosticsPanel
        socket={s}
        namespace="yamaha.0"
        timeouts={FAST}
      />,
    );
    const button = await screen.findByTestId("diag-export");
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(await screen.findByTestId("diag-done")).toHaveTextContent("yamaha_rx-v6a-2b3c_v3.3.0.json");
    expect(click).toHaveBeenCalled();
    expect(s.sendTo).toHaveBeenCalledWith("yamaha.0", "diagnostics", { action: "start", device: "rx-v6a-2b3c" });
    expect(s.sendTo).toHaveBeenCalledWith("yamaha.0", "diagnostics", { action: "result", job: "j1" });
  });

  it("shows that the report is being generated, with the seconds counting, until the answer comes", async () => {
    let done = false;
    const s = {
      sendTo: vi.fn((_i: string, _c: string, data: { action: string }) =>
        Promise.resolve(
          data.action === "list"
            ? { devices: [{ value: "rx-v6a-2b3c", label: "RX-V6A", connected: true }] }
            : data.action === "start"
              ? { job: "j1" }
              : done
                ? { error: "x" }
                : { pending: true },
        ),
      ),
    };
    render(
      <DiagnosticsPanel
        socket={s}
        namespace="yamaha.0"
        timeouts={FAST}
      />,
    );
    const button = await screen.findByTestId("diag-export");
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(await screen.findByTestId("diag-generating")).toHaveTextContent("yd_generating");
    expect(screen.getByTestId("diag-export")).toBeDisabled();
    // The count is wall-clock seconds: a busy runner showed 2 at its first look (CI 2026-10-06) — any second counts.
    await waitFor(() => expect(screen.getByTestId("diag-elapsed")).toHaveTextContent(/^yd_elapsed [1-9]\d*$/), {
      timeout: 2500,
    });
    done = true;
    await waitFor(() => expect(screen.queryByTestId("diag-generating")).toBeNull());
  });

  it("shows the adapter's error instead of a download", async () => {
    const s = socket({
      list: { devices: [{ value: "rx-v6a-2b3c", label: "RX-V6A", connected: false }] },
      export: { error: "a report for this device is being made right now" },
    });
    render(
      <DiagnosticsPanel
        socket={s}
        namespace="yamaha.0"
        timeouts={FAST}
      />,
    );
    const button = await screen.findByTestId("diag-export");
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(await screen.findByTestId("diag-error")).toHaveTextContent("being made right now");
  });

  it("says when the instance runs no device", async () => {
    render(
      <DiagnosticsPanel
        socket={socket({ list: { devices: [] } })}
        namespace="yamaha.0"
      />,
    );
    expect(await screen.findByTestId("diag-no-devices")).toBeInTheDocument();
  });

  it("does not show a broken list as an empty one", async () => {
    render(
      <DiagnosticsPanel
        socket={socket({ list: undefined })}
        namespace="yamaha.0"
      />,
    );
    expect(await screen.findByTestId("diag-list-failed")).toBeInTheDocument();
  });

  it("shows the error the adapter answers instead of its device list", async () => {
    render(
      <DiagnosticsPanel
        socket={socket({ list: { error: "diagnostics failed: boom" } })}
        namespace="yamaha.0"
      />,
    );
    expect(await screen.findByTestId("diag-list-failed")).toHaveTextContent("diagnostics failed: boom");
  });

  // Review 2026-10-05, B2: a stopped instance left the card at "Loading devices…" for good.
  it("says that the instance is not running instead of loading forever", async () => {
    const s = {
      sendTo: vi.fn(() => new Promise(() => {})),
      subscribeState: vi.fn((id: string, handler: (id: string, state: { val: unknown } | null) => void) => {
        void Promise.resolve().then(() => handler(id, { val: false }));
      }),
      unsubscribeState: vi.fn(),
    };
    render(
      <DiagnosticsPanel
        socket={s}
        namespace="yamaha.0"
        timeouts={FAST}
      />,
    );
    expect(await screen.findByTestId("diag-list-failed")).toHaveTextContent("yd_notRunning");
    expect(s.subscribeState).toHaveBeenCalledWith("system.adapter.yamaha.0.alive", expect.any(Function));
  });

  // Review 2026-10-05, B2: a restart during a report left the button locked.
  it("frees the button and says why when the instance stops during a report", async () => {
    let alive: (val: boolean) => void = () => {};
    const s = {
      sendTo: vi.fn((_i: string, _c: string, data: { action: string }) =>
        data.action === "list"
          ? Promise.resolve({ devices: [{ value: "rx-v6a-2b3c", label: "RX-V6A", connected: true }] })
          : new Promise(() => {}),
      ),
      subscribeState: vi.fn((id: string, handler: (id: string, state: { val: unknown } | null) => void) => {
        alive = val => handler(id, { val });
        handler(id, { val: true });
      }),
      unsubscribeState: vi.fn(),
    };
    render(
      <DiagnosticsPanel
        socket={s}
        namespace="yamaha.0"
        timeouts={FAST}
      />,
    );
    const button = await screen.findByTestId("diag-export");
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(await screen.findByTestId("diag-generating")).toBeInTheDocument();
    alive(false);
    expect(await screen.findByTestId("diag-error")).toHaveTextContent("yd_stopped");
    await waitFor(() => expect(screen.getByTestId("diag-export")).not.toBeDisabled());
    expect(screen.queryByTestId("diag-generating")).toBeNull();
  });
});
