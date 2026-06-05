# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).

Every PR that changes a publishable package under `packages/` must include a
changeset describing the change and the semver bump. Add one with:

```bash
pnpm changeset
```

Pick the affected packages, choose `patch` / `minor` / `major`, and write a
short human-readable summary — it becomes the changelog entry. On merge to
`main`, the Changesets GitHub Action opens (or updates) a "Version Packages" PR;
merging that PR publishes the bumped packages to npm.
