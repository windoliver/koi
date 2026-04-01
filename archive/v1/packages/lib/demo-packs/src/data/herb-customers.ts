/**
 * HERB customer directory — 120 customers generated deterministically.
 * Uses a seeded LCG (linear congruential generator) for reproducibility.
 * No external dependencies.
 */

import type { HerbCustomer } from "./herb-types.js";

// ---------------------------------------------------------------------------
// Deterministic PRNG (LCG) — same algorithm, different seed from employees
// ---------------------------------------------------------------------------

function createPrng(seed: number): () => number {
  // let justified: mutable PRNG state
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function pick<T>(arr: readonly T[], rng: () => number): T {
  // biome-ignore lint/style/noNonNullAssertion: array is always non-empty by construction
  return arr[Math.floor(rng() * arr.length)]!;
}

function randInt(min: number, max: number, rng: () => number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

// ---------------------------------------------------------------------------
// Company name pools
// ---------------------------------------------------------------------------

const COMPANY_PREFIXES: readonly string[] = [
  "Apex",
  "Beacon",
  "Crest",
  "Delta",
  "Echo",
  "Forge",
  "Grid",
  "Haven",
  "Iron",
  "Jade",
  "Keystone",
  "Lumen",
  "Meridian",
  "Nexus",
  "Orbit",
  "Pinnacle",
  "Quartz",
  "Ridge",
  "Summit",
  "Titan",
  "Unity",
  "Vertex",
  "Wave",
  "Xenon",
  "Yield",
  "Zenith",
  "Atlas",
  "Bolt",
  "Cipher",
  "Drift",
] as const;

const COMPANY_SUFFIXES: readonly string[] = [
  "Systems",
  "Technologies",
  "Solutions",
  "Labs",
  "Industries",
  "Analytics",
  "Dynamics",
  "Networks",
  "Ventures",
  "Digital",
  "Group",
  "Corp",
  "Partners",
  "Innovations",
  "Global",
  "AI",
  "Cloud",
  "Data",
  "Works",
  "Logic",
] as const;

const CONTACT_FIRST: readonly string[] = [
  "Alex",
  "Beth",
  "Carlos",
  "Diana",
  "Erik",
  "Fiona",
  "Gavin",
  "Helen",
  "Ivan",
  "Julia",
  "Kevin",
  "Laura",
  "Marco",
  "Nina",
  "Owen",
  "Paula",
  "Raj",
  "Sarah",
  "Tom",
  "Uma",
] as const;

const CONTACT_LAST: readonly string[] = [
  "Morgan",
  "Taylor",
  "Anderson",
  "Wilson",
  "Clark",
  "Lewis",
  "Hall",
  "Young",
  "King",
  "Wright",
  "Scott",
  "Green",
  "Baker",
  "Adams",
  "Nelson",
  "Hill",
  "Moore",
  "Jackson",
  "White",
  "Harris",
] as const;

// ---------------------------------------------------------------------------
// Distribution configuration
// ---------------------------------------------------------------------------

const TIERS = ["enterprise", "business", "starter"] as const;
const REGIONS = ["NA", "EMEA", "APAC", "LATAM"] as const;

/**
 * MRR ranges by tier [min, max] in USD.
 * Enterprise: $15k-$80k, Business: $2k-$15k, Starter: $200-$2k.
 */
const MRR_RANGES: Readonly<Record<(typeof TIERS)[number], readonly [number, number]>> = {
  enterprise: [15_000, 80_000],
  business: [2_000, 15_000],
  starter: [200, 2_000],
} as const;

// ---------------------------------------------------------------------------
// Date helper
// ---------------------------------------------------------------------------

function randomSignupDate(rng: () => number): string {
  const year = randInt(2019, 2025, rng);
  const month = randInt(1, 12, rng);
  const day = randInt(1, 28, rng);
  return `${String(year)}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Churn risk computation
// ---------------------------------------------------------------------------

function computeChurnRisk(
  healthScore: number,
  tier: (typeof TIERS)[number],
): "low" | "medium" | "high" {
  // Enterprise customers with decent health rarely churn
  if (tier === "enterprise" && healthScore >= 60) return "low";
  if (healthScore >= 75) return "low";
  if (healthScore >= 45) return "medium";
  return "high";
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

function generateCustomers(): readonly HerbCustomer[] {
  const rng = createPrng(7919); // different seed from employees
  const result: HerbCustomer[] = [];
  const usedNames = new Set<string>();

  for (let i = 0; i < 120; i++) {
    // Generate unique company name
    // let justified: may need to regenerate on collision
    let companyName: string;
    do {
      companyName = `${pick(COMPANY_PREFIXES, rng)} ${pick(COMPANY_SUFFIXES, rng)}`;
    } while (usedNames.has(companyName));
    usedNames.add(companyName);

    const id = `cust-${String(i + 1).padStart(4, "0")}`;
    const contactFirst = pick(CONTACT_FIRST, rng);
    const contactLast = pick(CONTACT_LAST, rng);
    const domain = companyName.toLowerCase().replace(/\s+/g, "");
    const email = `${contactFirst.toLowerCase()}.${contactLast.toLowerCase()}@${domain}.example.com`;

    // Tier distribution: ~20% enterprise, ~40% business, ~40% starter
    const tierRoll = rng();
    const tier: (typeof TIERS)[number] =
      tierRoll < 0.2 ? "enterprise" : tierRoll < 0.6 ? "business" : "starter";

    const region = pick(REGIONS, rng);
    const mrrRange = MRR_RANGES[tier];
    const mrr = randInt(mrrRange[0], mrrRange[1], rng);
    const signupDate = randomSignupDate(rng);
    const healthScore = randInt(10, 100, rng);
    const churnRisk = computeChurnRisk(healthScore, tier);

    result.push({
      id,
      name: companyName,
      email,
      tier,
      region,
      mrr,
      signupDate,
      healthScore,
      churnRisk,
    });
  }

  return result;
}

/** 120 HERB customers across tiers and regions, deterministically generated. */
export const HERB_CUSTOMERS: readonly HerbCustomer[] = generateCustomers();
