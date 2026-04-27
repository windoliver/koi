/** Zanzibar-style relationship tuple for ReBAC delegation. */
export interface RelationshipTuple {
  readonly subject: string;
  readonly relation: string;
  readonly object: string;
}

/** Nexus policy version tag for cheap poll comparison. */
export interface NexusVersionTag {
  readonly version: number;
  readonly updatedAt: number;
}
