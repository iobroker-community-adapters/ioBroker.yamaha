import config from "@iobroker/eslint-config";

export default [
  ...config,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["*.mjs", "vitest.config.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    ignores: [
      ".dev-server/",
      ".vscode/",
      "**/*.test.ts",
      "*.test.js",
      "test/**",
      "*.config.mjs",
      "build",
      // Generated coverage report (npm run coverage) — never lint it.
      "coverage",
      "admin",
      "node_modules",
      // Pre-rewrite reference code (XML/SSDP source for later phases) — never lint it.
      "legacy",
      "**/adapter-config.d.ts",
    ],
  },
];
