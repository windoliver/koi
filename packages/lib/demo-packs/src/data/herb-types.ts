/** HERB enterprise domain types — readonly interfaces for demo data. */

export interface HerbEmployee {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly department: HerbDepartment;
  readonly title: string;
  readonly managerId: string | undefined;
  readonly startDate: string;
  readonly location: string;
  readonly salary: number;
}

export type HerbDepartment = "Engineering" | "Sales" | "Marketing" | "Support" | "Operations";

export interface HerbCustomer {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly tier: "enterprise" | "business" | "starter";
  readonly region: "NA" | "EMEA" | "APAC" | "LATAM";
  readonly mrr: number;
  readonly signupDate: string;
  readonly healthScore: number;
  readonly churnRisk: "low" | "medium" | "high";
}

export interface HerbProduct {
  readonly id: string;
  readonly name: string;
  readonly category: "platform" | "add-on" | "service";
  readonly priceCents: number;
  readonly active: boolean;
  readonly launchDate: string;
  readonly description: string;
}

export interface HerbQaPair {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly category: string;
  readonly lastUpdated: string;
}
