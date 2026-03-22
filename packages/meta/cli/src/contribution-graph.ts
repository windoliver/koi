/**
 * RuntimeContributionGraph — structured package tree showing which
 * stack contributed which packages to the running agent.
 *
 * Replaces the flat debug inventory with a hierarchical view that
 * makes it clear where each middleware/provider/tool originated.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RuntimeContributionGraph {
  readonly stacks: readonly StackContribution[];
  readonly generatedAt: number;
}

export interface StackContribution {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly source: "manifest" | "operator" | "runtime";
  readonly status: "active" | "degraded" | "failed" | "skipped";
  readonly reason?: string | undefined;
  readonly packages: readonly PackageContribution[];
}

export interface PackageContribution {
  readonly id: string;
  readonly kind: "middleware" | "provider" | "tool" | "channel" | "engine" | "skill" | "subsystem";
  readonly source: "static" | "forged" | "dynamic" | "manifest" | "operator";
  readonly middlewareNames?: readonly string[] | undefined;
  readonly providerNames?: readonly string[] | undefined;
  readonly toolNames?: readonly string[] | undefined;
  readonly channelNames?: readonly string[] | undefined;
  readonly notes?: readonly string[] | undefined;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface ContributionBuilder {
  readonly addStack: (
    id: string,
    label: string,
    source: StackContribution["source"],
    status: StackContribution["status"],
    packages: readonly PackageContribution[],
    reason?: string,
  ) => void;
  readonly build: () => RuntimeContributionGraph;
}

export function createContributionBuilder(): ContributionBuilder {
  const stacks: StackContribution[] = [];
  return {
    addStack(id, label, source, status, packages, reason): void {
      const enabled = status === "active" || status === "degraded";
      stacks.push({
        id,
        label,
        enabled,
        source,
        status,
        ...(reason !== undefined ? { reason } : {}),
        packages,
      });
    },
    build(): RuntimeContributionGraph {
      return { stacks: [...stacks], generatedAt: Date.now() };
    },
  };
}

// ---------------------------------------------------------------------------
// Post-composition helpers
// ---------------------------------------------------------------------------

/**
 * Appends channel and engine stacks to a contribution graph.
 * Called after composition because channels and engines are resolved
 * outside the middleware composition layer.
 */
export function addPostCompositionContributions(
  base: RuntimeContributionGraph,
  channelNames: readonly string[],
  engineAdapterId: string,
  modelName: string,
): RuntimeContributionGraph {
  const extraStacks: StackContribution[] = [];

  if (channelNames.length > 0) {
    extraStacks.push({
      id: "channels",
      label: "Channels",
      enabled: true,
      source: "manifest",
      status: "active",
      packages: [
        {
          id: "@koi/channels",
          kind: "channel",
          source: "manifest",
          channelNames,
        },
      ],
    });
  }

  extraStacks.push({
    id: "engine",
    label: "Engine",
    enabled: true,
    source: "manifest",
    status: "active",
    packages: [
      {
        id: engineAdapterId,
        kind: "engine",
        source: "static",
        notes: [`model: ${modelName}`],
      },
    ],
  });

  return {
    stacks: [...base.stacks, ...extraStacks],
    generatedAt: base.generatedAt,
  };
}
