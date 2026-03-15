/**
 * Connected demo pack — seeds HERB enterprise data into Nexus.
 *
 * Demonstrates memory, search, data source discovery, and multi-agent
 * provisioning. All data is Nexus-first — no standalone SQLite.
 *
 * HERB data volumes:
 * - 530 employees (5 departments)
 * - 120 customers (3 tiers, 4 regions)
 * - 30 products (3 categories)
 * - 20 Q&A pairs
 */

import type { BatchWriteEntry } from "@koi/nexus-client";
import { batchWrite } from "@koi/nexus-client";
import { HERB_CUSTOMERS, HERB_EMPLOYEES, HERB_PRODUCTS, HERB_QA_PAIRS } from "../data/index.js";
import type { DemoPack, SeedContext, SeedResult } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build Nexus write entries for a category of HERB data. */
function buildEntries<T extends { readonly id: string }>(
  items: readonly T[],
  agentName: string,
  category: string,
): readonly BatchWriteEntry[] {
  return items.map((item) => ({
    path: `/agents/${agentName}/datasources/herb-${category}/${item.id}`,
    data: item,
  }));
}

// ---------------------------------------------------------------------------
// Seeder
// ---------------------------------------------------------------------------

async function seedConnected(ctx: SeedContext): Promise<SeedResult> {
  const counts: Record<string, number> = {};
  const summary: string[] = [];

  // Build all write entries across categories
  const employeeEntries = buildEntries(HERB_EMPLOYEES, ctx.agentName, "employees");
  const customerEntries = buildEntries(HERB_CUSTOMERS, ctx.agentName, "customers");
  const productEntries = buildEntries(HERB_PRODUCTS, ctx.agentName, "products");
  const qaEntries: readonly BatchWriteEntry[] = HERB_QA_PAIRS.map((qa) => ({
    path: `/agents/${ctx.agentName}/corpus/herb/${qa.id}`,
    data: { question: qa.question, answer: qa.answer, category: qa.category },
  }));

  // Seed memory entries (department summaries + org metadata)
  const memoryEntries: readonly BatchWriteEntry[] = [
    {
      path: `/agents/${ctx.agentName}/memory/herb/org-overview`,
      data: {
        company: "HERB",
        totalEmployees: HERB_EMPLOYEES.length,
        totalCustomers: HERB_CUSTOMERS.length,
        totalProducts: HERB_PRODUCTS.length,
        departments: ["Engineering", "Sales", "Marketing", "Support", "Operations"],
      },
    },
    {
      path: `/agents/${ctx.agentName}/memory/herb/customer-tiers`,
      data: {
        enterprise: HERB_CUSTOMERS.filter((c) => c.tier === "enterprise").length,
        business: HERB_CUSTOMERS.filter((c) => c.tier === "business").length,
        starter: HERB_CUSTOMERS.filter((c) => c.tier === "starter").length,
      },
    },
    {
      path: `/agents/${ctx.agentName}/memory/herb/product-categories`,
      data: {
        platform: HERB_PRODUCTS.filter((p) => p.category === "platform").length,
        addon: HERB_PRODUCTS.filter((p) => p.category === "add-on").length,
        service: HERB_PRODUCTS.filter((p) => p.category === "service").length,
      },
    },
  ];

  // Seed data source descriptors for discovery
  const dsEntries: readonly BatchWriteEntry[] = [
    {
      path: `/agents/${ctx.agentName}/workspace/datasources/herb-employees`,
      data: {
        name: "herb-employees",
        protocol: "nexus",
        description: "HERB employee directory (530 employees, 5 departments)",
      },
    },
    {
      path: `/agents/${ctx.agentName}/workspace/datasources/herb-customers`,
      data: {
        name: "herb-customers",
        protocol: "nexus",
        description: "HERB customer database (120 customers, 4 regions, 3 tiers)",
      },
    },
    {
      path: `/agents/${ctx.agentName}/workspace/datasources/herb-products`,
      data: {
        name: "herb-products",
        protocol: "nexus",
        description: "HERB product catalog (30 products, 3 categories)",
      },
    },
  ];

  // Parallel batch writes across all categories
  const [empResult, custResult, prodResult, qaResult, memResult, dsResult] = await Promise.all([
    batchWrite(ctx.nexusClient, employeeEntries),
    batchWrite(ctx.nexusClient, customerEntries),
    batchWrite(ctx.nexusClient, productEntries),
    batchWrite(ctx.nexusClient, qaEntries),
    batchWrite(ctx.nexusClient, memoryEntries),
    batchWrite(ctx.nexusClient, dsEntries),
  ]);

  // Tally results
  const empCount = empResult.ok ? empResult.value.succeeded : 0;
  const custCount = custResult.ok ? custResult.value.succeeded : 0;
  const prodCount = prodResult.ok ? prodResult.value.succeeded : 0;
  const qaCount = qaResult.ok ? qaResult.value.succeeded : 0;
  const memCount = memResult.ok ? memResult.value.succeeded : 0;
  const dsCount = dsResult.ok ? dsResult.value.succeeded : 0;

  counts.employees = empCount;
  counts.customers = custCount;
  counts.products = prodCount;
  counts.corpus = qaCount;
  counts.memory = memCount;
  counts.dataSources = dsCount;

  summary.push(`Employees: ${String(empCount)}/${String(HERB_EMPLOYEES.length)} seeded`);
  summary.push(`Customers: ${String(custCount)}/${String(HERB_CUSTOMERS.length)} seeded`);
  summary.push(`Products: ${String(prodCount)}/${String(HERB_PRODUCTS.length)} seeded`);
  summary.push(`Corpus: ${String(qaCount)} Q&A pairs ready`);
  summary.push(`Memory: ${String(memCount)} entities ready`);
  summary.push(`Data Sources: ${String(dsCount)} descriptors ready`);

  const allSeeded =
    empCount === HERB_EMPLOYEES.length &&
    custCount === HERB_CUSTOMERS.length &&
    prodCount === HERB_PRODUCTS.length &&
    qaCount === HERB_QA_PAIRS.length &&
    memCount === memoryEntries.length &&
    dsCount === dsEntries.length;

  return { ok: allSeeded, counts, summary };
}

export const CONNECTED_PACK: DemoPack = {
  id: "connected",
  name: "Connected (HERB Enterprise)",
  description:
    "HERB enterprise data: 530 employees, 120 customers, 30 products, 20 Q&A pairs — all Nexus-backed",
  requires: [],
  agentRoles: [
    {
      name: "primary",
      type: "copilot",
      lifecycle: "copilot",
      reuse: true,
      description: "HERB business assistant — employee lookup, customer analytics, product catalog",
    },
    {
      name: "analytics-helper",
      type: "copilot",
      lifecycle: "copilot",
      reuse: true,
      description:
        "Analytics specialist — runs deep queries on customer churn risk, revenue segmentation, and employee distribution",
    },
    {
      name: "data-worker",
      type: "worker",
      lifecycle: "worker",
      reuse: false,
      description:
        "Background worker that enriches customer records and computes derived metrics when primary requests analysis",
    },
  ],
  seed: seedConnected,
  prompts: [
    "How many employees does HERB have in Engineering?",
    "Which enterprise customers have the highest churn risk?",
    "Show me all products in the platform category with pricing.",
    "What is HERB's policy on remote work?",
  ],
} as const;
