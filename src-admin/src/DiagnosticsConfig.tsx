import React from "react";

import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from "@iobroker/json-config";

import { DiagnosticsPanel } from "./DiagnosticsPanel";

/**
 * jsonConfig `type: custom` mount point of the diagnostics card. Must extend {@link ConfigGeneric} — the
 * admin instantiates the exposed class and drives it through `renderItem`.
 */
export default class DiagnosticsConfig extends ConfigGeneric<ConfigGenericProps, ConfigGenericState> {
  renderItem(_error: string, _disabled: boolean): React.JSX.Element {
    const ctx = this.props.oContext;
    return (
      <DiagnosticsPanel
        socket={ctx.socket}
        namespace={`${ctx.adapterName}.${ctx.instance}`}
      />
    );
  }
}
