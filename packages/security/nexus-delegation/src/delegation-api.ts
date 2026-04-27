export type NexusNamespaceMode = "COPY" | "CLEAN" | "SHARED";

export interface NexusDelegateScope {
  readonly allowed_operations: readonly string[];
  readonly remove_grants: readonly string[];
  readonly scope_prefix?: string | undefined;
  readonly resource_patterns?: readonly string[] | undefined;
}

// Full NexusDelegationApi interface and factory added in Task 4
