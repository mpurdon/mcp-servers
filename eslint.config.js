import config from "@mpurdon/eslint-config";

/**
 * Root flat config so ESLint resolves a configuration for any file in the
 * monorepo — required by lint-staged, which runs `eslint --fix` from the repo
 * root on staged files across all packages. Each package also has its own
 * eslint.config.js for package-scoped `pnpm lint` runs; both re-export the
 * same shared config.
 */
export default config;
