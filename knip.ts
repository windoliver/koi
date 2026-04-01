import type { KnipConfig } from "knip";

const config: KnipConfig = {
  workspaces: {
    // Root workspace — standalone scripts as entry points
    ".": {
      entry: ["scripts/*.ts"],
      project: ["scripts/**/*.ts"],
    },

    // Default workspace pattern — knip auto-detects entries from package.json
    // exports/bin/main fields, so no explicit entry override needed
    "packages/*/*": {
      project: ["src/**/*.ts"],
    },

    // @koi/core has 27+ subpath exports — all top-level src files are entries
    "packages/kernel/core": {
      entry: ["src/*.ts"],
      project: ["src/**/*.ts"],
    },

    // Apps
    "apps/*": {
      project: ["src/**/*.ts", "src/**/*.tsx"],
    },
  },

  // Start with warn for all rules to avoid blocking CI on initial rollout.
  // Ratchet to error after cleanup (recommended order: unlisted → files → dependencies).
  rules: {
    files: "warn",
    dependencies: "warn",
    unlisted: "warn",
    unresolved: "warn",
    exports: "warn",
    types: "warn",
    devDependencies: "warn",
    duplicates: "warn",
  },

  // Plugins for tooling config detection
  tsup: true,
  typescript: true,
  biome: true,
};

export default config;
