import react from "@vitejs/plugin-react";
import commonjs from "vite-plugin-commonjs";
import { federation } from "@module-federation/vite";
import { moduleFederationShared } from "@iobroker/gui-components/modulefederation.admin.config";
import { readFileSync } from "node:fs";

// The admin loads this remote at runtime (jsonConfig `type: custom`, `custom/customComponents.js`);
// the build output goes to admin/custom via tasks.js. Same set-up as govee-smart's component.
const config = {
  plugins: [
    federation({
      manifest: true,
      name: "ConfigCustomYamahaSet",
      filename: "customComponents.js",
      exposes: {
        "./Components": "./src/Components.tsx",
      },
      remotes: {},
      shared: moduleFederationShared(JSON.parse(readFileSync("./package.json").toString())),
      // Nobody consumes the remote as a typed module; the plugin's own tsc pass would also trip over
      // the shared module imported from ../src/lib (outside rootDir).
      dts: false,
    }),
    react(),
    commonjs(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: 3000,
  },
  base: "./",
  build: {
    target: "chrome89",
    outDir: "./build",
  },
};

export default config;
