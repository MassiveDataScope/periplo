import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import i18next from "eslint-plugin-i18next";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    // Every visible string comes from src/i18n/en.json, so any language is one catalog away.
    ...i18next.configs["flat/recommended"],
    files: ["src/**/*.tsx"],
    ignores: ["**/*.test.tsx"],
  },
  {
    // The core is consumed only through its public entry points.
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [{ group: ["@periplo/core/src/*", "**/packages/core/**"], message: "Import @periplo/core through its exported subpaths only." }],
        },
      ],
    },
  },
  {
    // Screens compose the core; decoding, HTTP parsing and virtualization live and are tested there, once.
    files: ["src/features/**", "src/app/**"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@periplo/core/src/*", "**/packages/core/**"], message: "Import @periplo/core through its exported subpaths only." },
            { group: ["apache-arrow", "@tanstack/*", "openapi-fetch"], message: "Screens use @periplo/core instead of these libraries." },
          ],
        },
      ],
    },
  },
  {
    // `lake` owns the facts of the lake; `home` and `table` build screens on top of it, never the reverse (no cycle).
    files: ["src/features/lake/**"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [{ group: ["../home/*", "../table/*"], message: "features/lake owns the facts of the lake; it must not import from home or table." }],
        },
      ],
    },
  },
  {
    // The catalog tree is a leaf: any feature can use it, so it must not depend on another feature.
    files: ["src/features/catalog-tree/**"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../charts/*", "../discovery/*", "../etl/*", "../home/*", "../lake/*", "../query/*", "../shell/*", "../table/*"],
              message: "features/catalog-tree is a leaf: it must not import another feature.",
            },
          ],
        },
      ],
    },
  },
);
