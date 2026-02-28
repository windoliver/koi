/**
 * Mock factories for registry tool tests.
 *
 * Provides mock BrickRegistryReader, SkillRegistryReader, and VersionIndexReader
 * with spyOn()-compatible stubs. All methods return sensible defaults.
 */

import type {
  BrickArtifact,
  BrickKind,
  BrickPage,
  BrickRegistryReader,
  BrickSearchQuery,
  KoiError,
  RegistryComponent,
  Result,
  SkillId,
  SkillPage,
  SkillRegistryEntry,
  SkillRegistryReader,
  SkillSearchQuery,
  SkillVersion,
  VersionEntry,
  VersionIndexReader,
} from "@koi/core";

const EMPTY_PAGE: BrickPage = { items: [], total: 0 };
const EMPTY_SKILL_PAGE: SkillPage = { items: [], total: 0 };

export function createMockBrickRegistry(): BrickRegistryReader {
  return {
    search: (_query: BrickSearchQuery): BrickPage => EMPTY_PAGE,
    get: (_kind: BrickKind, _name: string): Result<BrickArtifact, KoiError> => ({
      ok: false,
      error: { code: "NOT_FOUND", message: "Brick not found", retryable: false },
    }),
  };
}

export function createMockSkillRegistry(): SkillRegistryReader {
  return {
    search: (_query: SkillSearchQuery): SkillPage => EMPTY_SKILL_PAGE,
    get: (_id: SkillId): Result<SkillRegistryEntry, KoiError> => ({
      ok: false,
      error: { code: "NOT_FOUND", message: "Skill not found", retryable: false },
    }),
    versions: (_id: SkillId): Result<readonly SkillVersion[], KoiError> => ({
      ok: false,
      error: { code: "NOT_FOUND", message: "No versions found", retryable: false },
    }),
    install: async (
      _id: SkillId,
      _version?: string,
    ): Promise<Result<BrickArtifact & { readonly kind: "skill" }, KoiError>> => ({
      ok: false,
      error: { code: "NOT_FOUND", message: "Skill not found for install", retryable: false },
    }),
  };
}

export function createMockVersionIndex(): VersionIndexReader {
  return {
    resolve: (
      _name: string,
      _kind: BrickKind,
      _version: string,
    ): Result<VersionEntry, KoiError> => ({
      ok: false,
      error: { code: "NOT_FOUND", message: "Version not found", retryable: false },
    }),
    resolveLatest: (_name: string, _kind: BrickKind): Result<VersionEntry, KoiError> => ({
      ok: false,
      error: { code: "NOT_FOUND", message: "No versions found", retryable: false },
    }),
    listVersions: (_name: string, _kind: BrickKind): Result<readonly VersionEntry[], KoiError> => ({
      ok: false,
      error: { code: "NOT_FOUND", message: "No versions found", retryable: false },
    }),
  };
}

export function createMockFacade(overrides?: {
  readonly bricks?: Partial<BrickRegistryReader>;
  readonly skills?: Partial<SkillRegistryReader>;
  readonly versions?: Partial<VersionIndexReader>;
}): RegistryComponent {
  return {
    bricks: { ...createMockBrickRegistry(), ...overrides?.bricks },
    skills: { ...createMockSkillRegistry(), ...overrides?.skills },
    versions: { ...createMockVersionIndex(), ...overrides?.versions },
  };
}
