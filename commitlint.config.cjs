/**
 * Conventional Commits enforced across the monorepo.
 * Scopes should match package names (e.g. feat(mongodb): ..., fix(sumologic): ...)
 * or repo-level areas (repo, cli, ci, deps).
 */
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      1,
      "always",
      [
        "mongodb",
        "sumologic",
        "freshbooks",
        "github",
        "milo",
        "cli",
        "repo",
        "ci",
        "deps",
        "release",
      ],
    ],
  },
};
