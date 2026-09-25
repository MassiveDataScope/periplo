import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  // Area boundaries: each area has its own entry point, so a consumer can load one without the others,
  // and the data and API areas never depend on the UI library.
  // Every block also bans the application and the package's own name: inside the
  // core, "@periplo/core/api" would resolve through `exports` and dodge the relative rules.
  ...[
    {
      files: ["src/arrow/**"],
      patterns: [
        { group: ["react", "react-dom", "react/*", "react-dom/*"], message: "The arrow area must stay free of React." },
        { group: ["**/api", "**/api/*", "**/grid", "**/grid/*", "**/ui", "**/ui/*"], message: "arrow depends on no other core area." },
      ],
    },
    {
      files: ["src/api/*.{ts,tsx}"],
      patterns: [
        { group: ["react", "react-dom", "react/*", "react-dom/*"], message: "Only src/api/react may use React." },
        { group: ["**/arrow", "**/arrow/*", "apache-arrow"], allowTypeImports: true, message: "api may only import types from Arrow; decoding belongs to the transport." },
        { group: ["**/grid", "**/grid/*", "**/ui", "**/ui/*"], message: "api does not depend on grid or ui." },
      ],
    },
    {
      files: ["src/api/react/**"],
      patterns: [
        { group: ["**/arrow", "**/arrow/*", "apache-arrow"], allowTypeImports: true, message: "api/react may only import types from Arrow." },
        { group: ["**/grid", "**/grid/*", "**/ui", "**/ui/*"], message: "api/react depends only on api and React." },
      ],
    },
    {
      files: ["src/grid/**"],
      patterns: [{ group: ["**/api", "**/api/*"], message: "grid receives GridStatusInput; it must not import the api area." }],
    },
    {
      files: ["src/ui/**"],
      patterns: [{ group: ["**/arrow", "**/arrow/*", "**/api", "**/api/*", "**/grid", "**/grid/*"], message: "ui depends on no other core area." }],
    },
    { files: ["playground/**", "tests/**", "src/**/*.test.{ts,tsx}"], patterns: [] },
  ].map(({ files, patterns }) => ({
    files,
    ignores: patterns.length > 0 ? ["**/*.test.{ts,tsx}"] : [],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            ...patterns,
            { group: ["**/apps/**", "periplo-web", "periplo-web/*"], message: "The core never imports the application." },
            { group: ["@periplo/core", "@periplo/core/*"], message: "Inside the core, import areas by relative path so the boundary rules apply." },
          ],
        },
      ],
    },
  })),
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
);
