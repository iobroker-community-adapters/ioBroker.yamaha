import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@iobroker/gui-components", () => ({
  I18n: { t: (key: string, ...args: unknown[]) => [key, ...args].join(" ") },
}));

import { DiagnosticsPanel } from "./DiagnosticsPanel";

function socket(answers: { list: unknown; export?: unknown }): { sendTo: ReturnType<typeof vi.fn> } {
  return {
    sendTo: vi.fn((_instance: string, _command: string, data: { action: string }) =>
      Promise.resolve(data.action === "list" ? answers.list : answers.export),
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
      />,
    );
    const button = await screen.findByTestId("diag-export");
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(await screen.findByTestId("diag-done")).toHaveTextContent("yamaha_rx-v6a-2b3c_v3.3.0.json");
    expect(click).toHaveBeenCalled();
    expect(s.sendTo).toHaveBeenCalledWith("yamaha.0", "diagnostics", { action: "export", device: "rx-v6a-2b3c" });
  });

  it("shows that the report is being generated, with the seconds counting, until the answer comes", async () => {
    let answer: (value: unknown) => void = () => {};
    const s = {
      sendTo: vi.fn((_i: string, _c: string, data: { action: string }) =>
        data.action === "list"
          ? Promise.resolve({ devices: [{ value: "rx-v6a-2b3c", label: "RX-V6A", connected: true }] })
          : new Promise(resolve => (answer = resolve)),
      ),
    };
    render(
      <DiagnosticsPanel
        socket={s}
        namespace="yamaha.0"
      />,
    );
    const button = await screen.findByTestId("diag-export");
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(await screen.findByTestId("diag-generating")).toHaveTextContent("yd_generating");
    expect(screen.getByTestId("diag-export")).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId("diag-elapsed")).toHaveTextContent("yd_elapsed 1"), {
      timeout: 2500,
    });
    answer({ error: "x" });
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
});
