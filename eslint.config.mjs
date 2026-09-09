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
      "test/**",
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
