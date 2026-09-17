import config from "@iobroker/eslint-config";

export default [
  ...config,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["*.mjs", "vitest.config.mts"] },
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
      // Session files of the note-taking hook: its cooldown marker
      // tmp/last-ndc.ts is a timestamp, not TypeScript — never lint them.
      ".remember/**",
      ".dev-server/",
      ".vscode/",
      "*.test.js",
      // Only the ioBroker TEMPLATE files under test/ are excluded — the synchronised standards
      // suite (test/standards/*.test.ts) is linted like every other test file (fleet rule
      // since 2026-09-02); "test/**" took it out of the lint entirely.
      "test/*.js",
      "*.config.mjs",
      "build",
      // Generated coverage report (npm run coverage) — never lint it.
      "coverage",
      "admin",
      "node_modules",
      "**/adapter-config.d.ts",
    ],
  },
];
