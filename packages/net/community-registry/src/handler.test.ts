import { describe, expect, test } from "bun:test";
import type { CommunityRegistryInstaller, MarketplacePublishRequest } from "./index.js";
import {
  computeMarketplaceTrustScore,
  createCommunityRegistryHandler,
  createInMemoryCommunityRegistryBackend,
} from "./index.js";

const SKILL_ARCHIVE_SHA256 = "0e541ff858cd80b4ccd6ab97cce5e5744cf0bec0ee9b21dfd4746e2607086f10";

function validSkillPublish(
  overrides: Partial<MarketplacePublishRequest> = {},
): MarketplacePublishRequest {
  return {
    kind: "skill",
    name: "context-scout",
    version: "1.2.0",
    description: "Searches a workspace for the right context before a coding task.",
    publisher: "koi-labs",
    category: "coding",
    tags: ["search", "context"],
    featured: true,
    artifact: {
      url: "https://registry.example/context-scout.tgz",
      sha256: SKILL_ARCHIVE_SHA256,
    },
    compatibility: {
      koi: ">=2.0.0",
    },
    skill: {
      name: "context-scout",
      description: "Searches a workspace for the right context before a coding task.",
      tags: ["search", "context"],
      compatibility: ">=2.0.0",
    },
    ...overrides,
  };
}

async function json(response: Response): Promise<unknown> {
  return response.json();
}

describe("community registry handler", () => {
  test("publish accepts a valid skill and discovery returns categories, featured, and new entries", async () => {
    const backend = createInMemoryCommunityRegistryBackend();
    const service = createCommunityRegistryHandler({
      backend,
      authTokens: new Set(["publish-token"]),
      now: () => new Date("2026-05-15T12:00:00.000Z"),
    });

    const publish = await service.handler(
      new Request("https://registry.example/v1/publish", {
        method: "POST",
        headers: {
          authorization: "Bearer publish-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(validSkillPublish()),
      }),
    );

    expect(publish?.status).toBe(201);

    const discovery = await service.handler(
      new Request("https://registry.example/v1/discovery?category=coding"),
    );
    const body = await json(discovery ?? new Response(null, { status: 500 }));

    expect(discovery?.status).toBe(200);
    expect(body).toEqual({
      categories: [
        {
          category: "coding",
          count: 1,
        },
      ],
      featured: [
        expect.objectContaining({
          kind: "skill",
          name: "context-scout",
          version: "1.2.0",
        }),
      ],
      newest: [
        expect.objectContaining({
          name: "context-scout",
          publishedAt: "2026-05-15T12:00:00.000Z",
        }),
      ],
    });
  });

  test("publish rejects invalid skill frontmatter", async () => {
    const service = createCommunityRegistryHandler({
      backend: createInMemoryCommunityRegistryBackend(),
      authTokens: new Set(["publish-token"]),
    });

    const response = await service.handler(
      new Request("https://registry.example/v1/publish", {
        method: "POST",
        headers: {
          authorization: "Bearer publish-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(validSkillPublish({ skill: { name: "", description: "" } })),
      }),
    );
    const body = await json(response ?? new Response(null, { status: 500 }));

    expect(response?.status).toBe(400);
    expect(body).toEqual({
      error: expect.stringContaining("Skill frontmatter validation failed"),
    });
  });

  test("publish accepts a valid plugin manifest", async () => {
    const service = createCommunityRegistryHandler({
      backend: createInMemoryCommunityRegistryBackend(),
    });

    const response = await service.handler(
      new Request("https://registry.example/v1/publish", {
        method: "POST",
        body: JSON.stringify({
          kind: "plugin",
          name: "code-review-kit",
          version: "1.0.0",
          description: "Plugin with review skills and hooks.",
          publisher: "koi-labs",
          category: "coding",
          artifact: {
            url: "https://registry.example/code-review-kit.tgz",
          },
          plugin: {
            name: "code-review-kit",
            version: "1.0.0",
            description: "Plugin with review skills and hooks.",
            skills: ["skills/review/SKILL.md"],
          },
        }),
      }),
    );
    const body = await json(response ?? new Response(null, { status: 500 }));

    expect(response?.status).toBe(201);
    expect(body).toEqual(
      expect.objectContaining({
        kind: "plugin",
        name: "code-review-kit",
        trust: expect.any(Number),
      }),
    );
  });

  test("search ranks relevant entries by full-text match", async () => {
    const backend = createInMemoryCommunityRegistryBackend();
    const service = createCommunityRegistryHandler({ backend });

    await backend.publish(
      validSkillPublish({ name: "context-scout", tags: ["context", "search"] }),
    );
    await backend.publish(
      validSkillPublish({
        name: "release-notes",
        description: "Formats release notes from merged pull requests.",
        category: "docs",
        tags: ["changelog"],
        skill: {
          name: "release-notes",
          description: "Formats release notes from merged pull requests.",
        },
      }),
    );

    const response = await service.handler(
      new Request("https://registry.example/v1/search?q=context&limit=10"),
    );
    const body = await json(response ?? new Response(null, { status: 500 }));

    expect(response?.status).toBe(200);
    expect(body).toEqual({
      items: [
        expect.objectContaining({
          name: "context-scout",
        }),
      ],
      nextCursor: null,
      total: 1,
    });
  });

  test("versions endpoint returns semver-sorted package versions", async () => {
    const backend = createInMemoryCommunityRegistryBackend();
    const service = createCommunityRegistryHandler({ backend });

    await backend.publish(validSkillPublish({ version: "1.2.0" }));
    await backend.publish(validSkillPublish({ version: "1.10.0" }));

    const response = await service.handler(
      new Request("https://registry.example/v1/packages/skill/context-scout/versions"),
    );
    const body = await json(response ?? new Response(null, { status: 500 }));

    expect(response?.status).toBe(200);
    expect(body).toEqual({
      items: [
        expect.objectContaining({ version: "1.10.0" }),
        expect.objectContaining({ version: "1.2.0" }),
      ],
    });
  });

  test("install downloads, verifies checksum, registers, and records download count", async () => {
    const backend = createInMemoryCommunityRegistryBackend();
    await backend.publish(validSkillPublish());

    const installed: string[] = [];
    const installer: CommunityRegistryInstaller = {
      install: async ({ entry, artifact }) => {
        installed.push(`${entry.kind}:${entry.name}@${entry.version}:${artifact.bytes.byteLength}`);
        return { installId: "install-1" };
      },
    };
    const service = createCommunityRegistryHandler({
      backend,
      installer,
      fetch: async () => new Response("skill archive"),
    });

    const response = await service.handler(
      new Request("https://registry.example/v1/install", {
        method: "POST",
        body: JSON.stringify({
          kind: "skill",
          name: "context-scout",
          koiVersion: "2.1.0",
        }),
      }),
    );
    const body = await json(response ?? new Response(null, { status: 500 }));

    expect(response?.status).toBe(200);
    expect(body).toEqual({
      installId: "install-1",
      entry: expect.objectContaining({
        name: "context-scout",
        downloads: 1,
      }),
      trust: expect.any(Number),
    });
    expect(installed).toEqual(["skill:context-scout@1.2.0:13"]);
  });

  test("install rejects incompatible Koi versions before downloading", async () => {
    const backend = createInMemoryCommunityRegistryBackend();
    await backend.publish(validSkillPublish({ compatibility: { koi: ">=3.0.0" } }));

    let fetchCount = 0;
    const service = createCommunityRegistryHandler({
      backend,
      installer: { install: async () => ({ installId: "unused" }) },
      fetch: async () => {
        fetchCount += 1;
        return new Response("skill archive");
      },
    });

    const response = await service.handler(
      new Request("https://registry.example/v1/install", {
        method: "POST",
        body: JSON.stringify({
          kind: "skill",
          name: "context-scout",
          koiVersion: "2.1.0",
        }),
      }),
    );

    expect(response?.status).toBe(409);
    expect(fetchCount).toBe(0);
  });

  test("install accepts common semver caret compatibility ranges", async () => {
    const backend = createInMemoryCommunityRegistryBackend();
    await backend.publish(validSkillPublish({ compatibility: { koi: "^2.0.0" } }));

    const service = createCommunityRegistryHandler({
      backend,
      installer: { install: async () => ({ installId: "install-1" }) },
      fetch: async () => new Response("skill archive"),
    });

    const response = await service.handler(
      new Request("https://registry.example/v1/install", {
        method: "POST",
        body: JSON.stringify({
          kind: "skill",
          name: "context-scout",
          koiVersion: "2.1.0",
        }),
      }),
    );

    expect(response?.status).toBe(200);
  });

  test("install rejects checksum mismatch", async () => {
    const backend = createInMemoryCommunityRegistryBackend();
    await backend.publish(validSkillPublish());
    const service = createCommunityRegistryHandler({
      backend,
      installer: { install: async () => ({ installId: "unused" }) },
      fetch: async () => new Response("different archive"),
    });

    const response = await service.handler(
      new Request("https://registry.example/v1/install", {
        method: "POST",
        body: JSON.stringify({
          kind: "skill",
          name: "context-scout",
          koiVersion: "2.1.0",
        }),
      }),
    );

    expect(response?.status).toBe(422);
  });

  test("install rejects artifact size mismatch before registration", async () => {
    const backend = createInMemoryCommunityRegistryBackend();
    await backend.publish(
      validSkillPublish({
        artifact: {
          url: "https://registry.example/context-scout.tgz",
          sizeBytes: 100,
        },
      }),
    );
    let installCount = 0;
    const service = createCommunityRegistryHandler({
      backend,
      installer: {
        install: async () => {
          installCount += 1;
          return { installId: "unused" };
        },
      },
      fetch: async () => new Response("short"),
    });

    const response = await service.handler(
      new Request("https://registry.example/v1/install", {
        method: "POST",
        body: JSON.stringify({
          kind: "skill",
          name: "context-scout",
          koiVersion: "2.1.0",
        }),
      }),
    );

    expect(response?.status).toBe(422);
    expect(installCount).toBe(0);
  });

  test("trust score combines usage, rating, publisher reputation, and findings", () => {
    const score = computeMarketplaceTrustScore({
      downloads: 500,
      rating: 4.5,
      publisherReputation: 0.8,
      securityFindings: [
        {
          severity: "HIGH",
          message: "network exfiltration risk",
        },
      ],
    });

    expect(score).toBe(63);
  });
});
