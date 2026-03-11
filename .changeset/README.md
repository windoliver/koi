# Changesets

This directory is used by [@changesets/cli](https://github.com/changesets/changesets) to manage
versioning and changelogs for the Koi monorepo.

## Adding a changeset

When your PR includes changes that should bump a package version:

```bash
bunx changeset
```

Follow the prompts to select affected packages and semver bump type.

## Versioning and publishing

```bash
# Apply changesets → bump versions + generate changelogs
bunx changeset version

# Workaround for Bun workspace:* resolution (oven-sh/bun#24687)
bun update

# Publish to npm
bunx changeset publish
```
