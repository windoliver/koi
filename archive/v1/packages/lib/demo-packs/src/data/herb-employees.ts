/**
 * HERB employee directory — 530 employees generated deterministically.
 * Uses a seeded LCG (linear congruential generator) for reproducibility.
 * No external dependencies.
 */

import type { HerbDepartment, HerbEmployee } from "./herb-types.js";

// ---------------------------------------------------------------------------
// Deterministic PRNG (LCG)
// ---------------------------------------------------------------------------

function createPrng(seed: number): () => number {
  // let justified: mutable PRNG state
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/** Pick a random element from a readonly array using the PRNG. */
function pick<T>(arr: readonly T[], rng: () => number): T {
  // biome-ignore lint/style/noNonNullAssertion: array is always non-empty by construction
  return arr[Math.floor(rng() * arr.length)]!;
}

/** Return a random integer in [min, max] (inclusive). */
function randInt(min: number, max: number, rng: () => number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

// ---------------------------------------------------------------------------
// Name pools (50+ each)
// ---------------------------------------------------------------------------

const FIRST_NAMES: readonly string[] = [
  "Aiden",
  "Amara",
  "Blake",
  "Carmen",
  "Darian",
  "Elena",
  "Farid",
  "Grace",
  "Hassan",
  "Iris",
  "Jordan",
  "Kira",
  "Leo",
  "Maya",
  "Nadia",
  "Oscar",
  "Priya",
  "Quinn",
  "Rafael",
  "Sasha",
  "Tara",
  "Uma",
  "Victor",
  "Wendy",
  "Xavier",
  "Yara",
  "Zane",
  "Aria",
  "Boris",
  "Celia",
  "Dante",
  "Elise",
  "Feng",
  "Greta",
  "Hugo",
  "Ingrid",
  "Jasper",
  "Kaia",
  "Liam",
  "Mira",
  "Nico",
  "Olive",
  "Pavel",
  "Rosa",
  "Stefan",
  "Thea",
  "Uri",
  "Vera",
  "Wren",
  "Xia",
  "Yusuf",
  "Zara",
  "Alec",
  "Bria",
  "Cyrus",
] as const;

const LAST_NAMES: readonly string[] = [
  "Adams",
  "Becker",
  "Chen",
  "Diaz",
  "Evans",
  "Foster",
  "Garcia",
  "Huang",
  "Iyer",
  "Jensen",
  "Kim",
  "Liu",
  "Martinez",
  "Nakamura",
  "Olsen",
  "Park",
  "Quinn",
  "Reyes",
  "Singh",
  "Torres",
  "Ueda",
  "Varga",
  "Wang",
  "Xu",
  "Yamamoto",
  "Zhang",
  "Ali",
  "Brennan",
  "Costa",
  "Devi",
  "Eriksson",
  "Fernandez",
  "Gupta",
  "Hayashi",
  "Ibrahim",
  "Johansson",
  "Kato",
  "Lopez",
  "Muller",
  "Novak",
  "Okafor",
  "Petrov",
  "Ramos",
  "Sato",
  "Tanaka",
  "Usman",
  "Volkov",
  "Weber",
  "Xie",
  "Yoshida",
  "Zimmer",
  "Anderson",
  "Brooks",
  "Clarke",
  "Douglas",
] as const;

const CITIES: readonly string[] = [
  "San Francisco, CA",
  "New York, NY",
  "Austin, TX",
  "Seattle, WA",
  "Chicago, IL",
  "Boston, MA",
  "Denver, CO",
  "Portland, OR",
  "Atlanta, GA",
  "Miami, FL",
  "London, UK",
  "Berlin, DE",
  "Toronto, CA",
  "Sydney, AU",
  "Singapore, SG",
  "Dublin, IE",
  "Amsterdam, NL",
  "Bangalore, IN",
  "Tokyo, JP",
  "Sao Paulo, BR",
] as const;

// ---------------------------------------------------------------------------
// Department configuration
// ---------------------------------------------------------------------------

const DEPARTMENTS: readonly HerbDepartment[] = [
  "Engineering",
  "Sales",
  "Marketing",
  "Support",
  "Operations",
] as const;

/** Target employee count per department (totals 530). */
const DEPT_SIZES: Readonly<Record<HerbDepartment, number>> = {
  Engineering: 200,
  Sales: 120,
  Marketing: 80,
  Support: 80,
  Operations: 50,
} as const;

/** Titles by department, ordered from senior to junior. */
const DEPT_TITLES: Readonly<Record<HerbDepartment, readonly string[]>> = {
  Engineering: [
    "VP of Engineering",
    "Senior Director of Engineering",
    "Engineering Director",
    "Engineering Manager",
    "Staff Engineer",
    "Senior Software Engineer",
    "Software Engineer",
    "Junior Software Engineer",
    "QA Engineer",
    "DevOps Engineer",
    "Site Reliability Engineer",
    "Security Engineer",
    "Data Engineer",
    "Platform Engineer",
  ],
  Sales: [
    "VP of Sales",
    "Sales Director",
    "Regional Sales Manager",
    "Senior Account Executive",
    "Account Executive",
    "Sales Development Rep",
    "Solutions Engineer",
    "Sales Operations Analyst",
    "Enterprise Account Manager",
    "Inside Sales Rep",
  ],
  Marketing: [
    "VP of Marketing",
    "Marketing Director",
    "Senior Product Marketing Manager",
    "Product Marketing Manager",
    "Content Strategist",
    "Growth Marketing Manager",
    "Demand Generation Specialist",
    "Marketing Analyst",
    "Brand Manager",
    "Events Coordinator",
  ],
  Support: [
    "VP of Customer Success",
    "Support Director",
    "Senior Support Engineer",
    "Support Engineer",
    "Technical Account Manager",
    "Customer Success Manager",
    "Support Operations Lead",
    "Knowledge Base Editor",
    "Support Analyst",
    "Onboarding Specialist",
  ],
  Operations: [
    "VP of Operations",
    "Operations Director",
    "Senior Operations Manager",
    "Operations Manager",
    "Finance Analyst",
    "HR Business Partner",
    "Facilities Coordinator",
    "Legal Counsel",
    "Procurement Specialist",
    "Office Manager",
  ],
} as const;

/** Salary ranges by seniority tier [min, max] in USD. */
const SALARY_TIERS: readonly (readonly [number, number])[] = [
  [220_000, 350_000], // VP / Director (index 0-1)
  [160_000, 240_000], // Senior Director / Director (index 2-3)
  [130_000, 180_000], // Manager / Staff (index 4-5)
  [100_000, 145_000], // Senior IC (index 6-7)
  [75_000, 110_000], // Mid IC (index 8-11)
  [55_000, 80_000], // Junior (index 12+)
] as const;

function salaryForTitleIndex(titleIndex: number, rng: () => number): number {
  // let justified: tier index derived from title position
  let tier: number;
  if (titleIndex <= 1) tier = 0;
  else if (titleIndex <= 3) tier = 1;
  else if (titleIndex <= 5) tier = 2;
  else if (titleIndex <= 7) tier = 3;
  else if (titleIndex <= 11) tier = 4;
  else tier = 5;

  const range = SALARY_TIERS[Math.min(tier, SALARY_TIERS.length - 1)];
  if (range === undefined) return 80_000;
  return randInt(range[0], range[1], rng);
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Generate a start date between 2016-01-01 and 2025-12-31. */
function randomStartDate(rng: () => number): string {
  const year = randInt(2016, 2025, rng);
  const month = randInt(1, 12, rng);
  const day = randInt(1, 28, rng);
  return `${String(year)}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

function generateEmployees(): readonly HerbEmployee[] {
  const rng = createPrng(42);
  const result: HerbEmployee[] = [];

  // Track managers per department for managerId assignment
  const deptManagers: Map<HerbDepartment, readonly string[]> = new Map();

  for (const dept of DEPARTMENTS) {
    const count = DEPT_SIZES[dept];
    const titles = DEPT_TITLES[dept];
    const managers: string[] = [];

    for (let i = 0; i < count; i++) {
      const id = `emp-${String(result.length + 1).padStart(4, "0")}`;
      const firstName = pick(FIRST_NAMES, rng);
      const lastName = pick(LAST_NAMES, rng);
      const name = `${firstName} ${lastName}`;
      const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@herb.example.com`;

      const titleIndex = Math.min(Math.floor(rng() * rng() * titles.length), titles.length - 1);
      // biome-ignore lint/style/noNonNullAssertion: titleIndex is bounded by titles.length
      const title = titles[titleIndex]!;

      const salary = salaryForTitleIndex(titleIndex, rng);
      const location = pick(CITIES, rng);
      const startDate = randomStartDate(rng);

      // First employee in department is VP (no manager). Others get a manager.
      const existingManagers = deptManagers.get(dept) ?? [];
      const managerId: string | undefined =
        i === 0 ? undefined : existingManagers.length > 0 ? pick(existingManagers, rng) : undefined;

      // Titles with index <= 3 are managers
      if (titleIndex <= 3) {
        managers.push(id);
      }

      result.push({
        id,
        name,
        email,
        department: dept,
        title,
        managerId,
        startDate,
        location,
        salary,
      });
    }

    deptManagers.set(dept, managers);
  }

  return result;
}

/** 530 HERB employees across 5 departments, deterministically generated. */
export const HERB_EMPLOYEES: readonly HerbEmployee[] = generateEmployees();
