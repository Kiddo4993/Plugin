// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // The whole point of packages/core: it must be usable headlessly (CLI,
    // CI, any editor) with zero coupling to the VS Code extension host.
    // This is enforced here, not just by convention — see docs/DESIGN.md.
    files: ["packages/core/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: [{ name: "vscode", message: "packages/core must have zero vscode imports — see docs/DESIGN.md." }] }],
    },
  },
);
