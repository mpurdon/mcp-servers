import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/**
 * Shared flat ESLint config for @mpurdon MCP server packages.
 * Consume from a package's eslint.config.js:
 *
 *   import config from "@mpurdon/eslint-config";
 *   export default config;
 */
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "*.config.js", "*.config.cjs"],
  },
  prettier,
);
