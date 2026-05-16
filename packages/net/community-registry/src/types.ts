export type MarketplaceKind = "skill" | "plugin";

export type MarketplaceSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface MarketplaceArtifact {
  readonly url: string;
  readonly sha256?: string | undefined;
  readonly sizeBytes?: number | undefined;
}

export interface MarketplaceCompatibility {
  readonly koi?: string | undefined;
}

export interface MarketplacePublishRequest {
  readonly kind: MarketplaceKind;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly publisher: string;
  readonly category: string;
  readonly tags?: readonly string[] | undefined;
  readonly featured?: boolean | undefined;
  readonly artifact: MarketplaceArtifact;
  readonly compatibility?: MarketplaceCompatibility | undefined;
  readonly skill?: Readonly<Record<string, unknown>> | undefined;
  readonly plugin?: unknown;
  readonly rating?: number | undefined;
  readonly publisherReputation?: number | undefined;
  readonly securityFindings?: readonly MarketplaceSecurityFinding[] | undefined;
}

export interface MarketplaceSecurityFinding {
  readonly severity: MarketplaceSeverity;
  readonly message: string;
}

export interface MarketplaceEntry extends MarketplacePublishRequest {
  readonly id: string;
  readonly publishedAt: string;
  readonly updatedAt: string;
  readonly downloads: number;
  readonly trust: number;
}

export interface MarketplaceSearchQuery {
  readonly q?: string | undefined;
  readonly kind?: MarketplaceKind | undefined;
  readonly category?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface MarketplaceSearchPage {
  readonly items: readonly MarketplaceEntry[];
  readonly total: number;
  readonly nextCursor: string | null;
}

export interface MarketplaceDiscovery {
  readonly categories: readonly MarketplaceCategory[];
  readonly featured: readonly MarketplaceEntry[];
  readonly newest: readonly MarketplaceEntry[];
}

export interface MarketplaceCategory {
  readonly category: string;
  readonly count: number;
}

export interface MarketplaceVersionPage {
  readonly items: readonly MarketplaceEntry[];
}

export interface InstallRequest {
  readonly kind: MarketplaceKind;
  readonly name: string;
  readonly version?: string | undefined;
  readonly koiVersion?: string | undefined;
}

export interface InstallArtifact {
  readonly bytes: Uint8Array;
  readonly contentType?: string | undefined;
}

export interface InstallContext {
  readonly entry: MarketplaceEntry;
  readonly artifact: InstallArtifact;
}

export interface InstallResult {
  readonly installId: string;
}

export interface CommunityRegistryInstaller {
  readonly install: (context: InstallContext) => Promise<InstallResult>;
}

export interface CommunityRegistryBackend {
  readonly publish: (request: MarketplacePublishRequest, now?: Date) => Promise<MarketplaceEntry>;
  readonly get: (
    kind: MarketplaceKind,
    name: string,
    version?: string,
  ) => Promise<MarketplaceEntry | null>;
  readonly versions: (kind: MarketplaceKind, name: string) => Promise<readonly MarketplaceEntry[]>;
  readonly search: (query: MarketplaceSearchQuery) => Promise<MarketplaceSearchPage>;
  readonly discovery: (query?: {
    readonly category?: string | undefined;
  }) => Promise<MarketplaceDiscovery>;
  readonly recordInstall: (
    kind: MarketplaceKind,
    name: string,
    version: string,
  ) => Promise<MarketplaceEntry | null>;
}

export interface CommunityRegistryConfig {
  readonly backend: CommunityRegistryBackend;
  readonly authTokens?: ReadonlySet<string> | undefined;
  readonly installer?: CommunityRegistryInstaller | undefined;
  readonly fetch?: RegistryFetch | undefined;
  readonly now?: (() => Date) | undefined;
}

export type RegistryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CommunityRegistryHandler {
  readonly handler: (request: Request) => Promise<Response | null>;
  readonly dispose: () => void;
}

export interface TrustScoreInput {
  readonly downloads?: number | undefined;
  readonly rating?: number | undefined;
  readonly publisherReputation?: number | undefined;
  readonly securityFindings?: readonly MarketplaceSecurityFinding[] | undefined;
}
