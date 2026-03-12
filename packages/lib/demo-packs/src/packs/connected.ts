/**
 * Connected demo pack — seeds search corpus, memory entities, and audit trail.
 * Designed to demonstrate memory + search capabilities on first run.
 */

import { writeJson } from "@koi/nexus-client";
import type { DemoPack, SeedContext, SeedResult } from "../types.js";

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const MEMORY_ENTRIES: readonly {
  readonly key: string;
  readonly value: Readonly<Record<string, unknown>>;
}[] = [
  {
    key: "user/profile",
    value: {
      name: "Demo User",
      role: "Developer",
      interests: ["TypeScript", "AI agents", "distributed systems"],
      timezone: "UTC",
    },
  },
  {
    key: "user/preferences",
    value: {
      responseStyle: "concise",
      codeStyle: "functional",
      language: "TypeScript",
    },
  },
  {
    key: "learning/react-server-components",
    value: {
      topic: "React Server Components",
      notes:
        "Server Components run on the server and never ship to the client. They can directly access databases, filesystems, and backend services. Client Components handle interactivity.",
      source: "Next.js documentation",
      date: "2025-03-01",
    },
  },
  {
    key: "learning/authentication-patterns",
    value: {
      topic: "Authentication Patterns",
      notes:
        "JWT for stateless auth, session tokens for stateful. PKCE flow for SPAs. Refresh tokens stored httpOnly. OAuth2 for third-party integration.",
      source: "Auth0 best practices",
      date: "2025-02-15",
    },
  },
  {
    key: "project/deployment-pipeline",
    value: {
      topic: "Deployment Pipeline",
      notes:
        "CI/CD runs on GitHub Actions. Staging deploys on PR merge. Production requires manual approval. Canary deploys to 5% first.",
      source: "Team documentation",
      date: "2025-01-20",
    },
  },
  {
    key: "project/api-design",
    value: {
      topic: "API Design Guidelines",
      notes:
        "REST for CRUD, WebSocket for real-time. Always version APIs (/v1/). Use JSON:API envelope. Rate limit at 100 req/min per key.",
      source: "Architecture decision record #42",
      date: "2025-02-28",
    },
  },
  {
    key: "tool/database-optimization",
    value: {
      topic: "Database Optimization",
      notes:
        "Index columns used in WHERE and JOIN. Avoid SELECT *. Use EXPLAIN ANALYZE. Connection pooling with PgBouncer. Partition large tables by date.",
      source: "PostgreSQL performance tuning session",
      date: "2025-03-05",
    },
  },
  {
    key: "insight/testing-strategy",
    value: {
      topic: "Testing Strategy",
      notes:
        "Unit tests for pure functions. Integration tests for API endpoints. E2E for critical flows only. Mock external services, never databases.",
      source: "Team retrospective",
      date: "2025-02-10",
    },
  },
];

const CORPUS_DOCS: readonly {
  readonly key: string;
  readonly content: string;
}[] = [
  {
    key: "docs/architecture",
    content:
      "The system uses a layered architecture: L0 defines contracts, L1 is the runtime kernel, L2 packages are features, L3 are convenience bundles. Each layer can only import from layers below it.",
  },
  {
    key: "docs/deployment",
    content:
      "Deployments use a blue-green strategy. The CI pipeline builds, tests, and packages the application. Staging deploys automatically on merge to main. Production requires a manual approval gate.",
  },
  {
    key: "docs/security",
    content:
      "All API endpoints require authentication. Tokens are rotated every 24 hours. Secrets are stored in Vault, never in environment variables. Rate limiting prevents abuse at 100 requests per minute.",
  },
];

// ---------------------------------------------------------------------------
// Seeder
// ---------------------------------------------------------------------------

async function seedConnected(ctx: SeedContext): Promise<SeedResult> {
  const counts: Record<string, number> = {};
  const summary: string[] = [];

  // 1. Seed memory entries via Nexus
  let memoryCount = 0;
  for (const entry of MEMORY_ENTRIES) {
    const result = await writeJson(
      ctx.nexusClient,
      `/agents/${ctx.agentName}/memory/${entry.key}`,
      entry.value,
    );
    if (result.ok) {
      memoryCount++;
    } else if (ctx.verbose) {
      summary.push(`  warn: failed to seed memory ${entry.key}: ${result.error.message}`);
    }
  }
  counts.memory = memoryCount;
  summary.push(`Memory: ${String(memoryCount)} entities ready`);

  // 2. Seed corpus documents via Nexus
  let corpusCount = 0;
  for (const doc of CORPUS_DOCS) {
    const result = await writeJson(ctx.nexusClient, `/agents/${ctx.agentName}/corpus/${doc.key}`, {
      content: doc.content,
      indexedAt: Date.now(),
    });
    if (result.ok) {
      corpusCount++;
    } else if (ctx.verbose) {
      summary.push(`  warn: failed to seed corpus ${doc.key}: ${result.error.message}`);
    }
  }
  counts.corpus = corpusCount;
  summary.push(`Corpus: ${String(corpusCount)} documents ready`);

  const allSeeded = memoryCount === MEMORY_ENTRIES.length && corpusCount === CORPUS_DOCS.length;

  return { ok: allSeeded, counts, summary };
}

export const CONNECTED_PACK: DemoPack = {
  id: "connected",
  name: "Connected",
  description: "Search corpus, memory entities, and knowledge base for demo exploration",
  requires: [],
  agentRoles: [
    {
      name: "primary",
      type: "copilot",
      lifecycle: "copilot",
      reuse: true,
      description: "Primary demo agent with seeded memory and search",
    },
    {
      name: "research-helper",
      type: "copilot",
      lifecycle: "copilot",
      reuse: true,
      description:
        "Research assistant — searches the knowledge base and summarizes findings on behalf of the primary agent",
    },
    {
      name: "note-worker",
      type: "worker",
      lifecycle: "worker",
      reuse: false,
      description:
        "Background worker that indexes new documents and updates memory entries when the primary agent learns something new",
    },
  ],
  seed: seedConnected,
  prompts: [
    "What did I learn about React Server Components?",
    "Summarize everything I know about authentication.",
    "Find my notes about the deployment pipeline.",
    "What are my API design guidelines?",
  ],
} as const;
