import type { SandboxProfile } from "@koi/core";

export type SandboxProfileOverrides = Omit<
  Partial<SandboxProfile>,
  "filesystem" | "network" | "resources"
> & {
  readonly filesystem?: Partial<SandboxProfile["filesystem"]>;
  readonly network?: Partial<SandboxProfile["network"]>;
  readonly resources?: Partial<SandboxProfile["resources"]>;
};

export const SENSITIVE_CREDENTIAL_PATHS: readonly string[] = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.config/gcloud",
  "~/.azure",
  "~/.kube",
  "~/.docker",
  "~/.netrc",
  "~/.npmrc",
  "~/.pypirc",
  "~/.git-credentials",
  // Password managers & desktop keyrings
  "~/.config/op",
  "~/.config/1Password",
  "~/.password-store",
  "~/.local/share/keyrings",
  "~/.local/share/gnome-keyring",
  // Additional cloud / CI credential stores
  "~/.config/gh",
  "~/.config/glab",
];

function expandHome(path: string): string {
  if (!path.startsWith("~/")) {
    return path;
  }

  const home = process.env.HOME;
  return home === undefined ? path : `${home}${path.slice(1)}`;
}

export function mergeProfile(
  base: SandboxProfile,
  overrides: SandboxProfileOverrides,
): SandboxProfile {
  return {
    ...base,
    ...overrides,
    filesystem: {
      ...base.filesystem,
      ...overrides.filesystem,
    },
    network: {
      ...base.network,
      ...overrides.network,
    },
    resources: {
      ...base.resources,
      ...overrides.resources,
    },
    ...(base.env !== undefined || overrides.env !== undefined
      ? { env: { ...(base.env ?? {}), ...(overrides.env ?? {}) } }
      : {}),
    ...(base.nexusMounts !== undefined || overrides.nexusMounts !== undefined
      ? { nexusMounts: overrides.nexusMounts ?? base.nexusMounts }
      : {}),
  };
}

export function restrictiveProfile(opts?: {
  readonly extraDenyRead?: readonly string[];
}): SandboxProfile {
  const denyRead = [
    ...SENSITIVE_CREDENTIAL_PATHS.map((path) => expandHome(path)),
    ...(opts?.extraDenyRead ?? []),
  ];

  return {
    filesystem: {
      defaultReadAccess: "open",
      denyRead,
    },
    network: {
      allow: false,
    },
    resources: {
      maxPids: 64,
      maxOpenFiles: 256,
    },
  };
}

export function permissiveProfile(): SandboxProfile {
  return {
    filesystem: {
      defaultReadAccess: "open",
    },
    network: {
      allow: true,
    },
    resources: {
      maxPids: 256,
      maxOpenFiles: 1024,
    },
  };
}
