/**
 * HERB Q&A pairs — 20 frequently asked questions about HERB enterprise topics.
 * Hardcoded const array; no external dependencies.
 */

import type { HerbQaPair } from "./herb-types.js";

export const HERB_QA_PAIRS: readonly HerbQaPair[] = [
  {
    id: "qa-001",
    question: "What is HERB Core Platform?",
    answer:
      "HERB Core Platform is an enterprise workflow orchestration engine that provides a built-in audit trail, role-based access control, and extensible plugin architecture for automating complex business processes.",
    category: "product",
    lastUpdated: "2025-11-01",
  },
  {
    id: "qa-002",
    question: "How does HERB handle single sign-on?",
    answer:
      "HERB Identity Hub supports SAML 2.0, OIDC, and LDAP out of the box. The SSO Premium Connector add-on extends this to non-standard identity providers. All authentication events are logged in the audit trail.",
    category: "security",
    lastUpdated: "2025-10-15",
  },
  {
    id: "qa-003",
    question: "What compliance certifications does HERB hold?",
    answer:
      "HERB maintains SOC 2 Type II, ISO 27001, and GDPR compliance certifications. The Compliance Vault product automates evidence collection and continuous monitoring for these frameworks.",
    category: "compliance",
    lastUpdated: "2025-12-01",
  },
  {
    id: "qa-004",
    question: "What is the uptime SLA for HERB platform?",
    answer:
      "Enterprise tier customers receive a 99.99% uptime SLA. Business tier receives 99.95%. Starter tier receives 99.9%. SLA credits are automatically applied to the next billing cycle.",
    category: "billing",
    lastUpdated: "2025-09-20",
  },
  {
    id: "qa-005",
    question: "How do I migrate data from a competitor platform?",
    answer:
      "HERB offers the Data Migration Service for white-glove migration with validation. For self-service, use the Data Export Toolkit add-on to import Parquet, CSV, or JSON files via the bulk import API.",
    category: "onboarding",
    lastUpdated: "2025-11-10",
  },
  {
    id: "qa-006",
    question: "What regions are supported for data residency?",
    answer:
      "HERB operates in US-East, US-West, EU-Frankfurt, EU-Dublin, APAC-Sydney, and APAC-Tokyo. The Geo-Redundancy Pack add-on enables multi-region active-active replication with automatic failover.",
    category: "infrastructure",
    lastUpdated: "2025-10-01",
  },
  {
    id: "qa-007",
    question: "How does the HERB Event Bus guarantee delivery?",
    answer:
      "HERB Event Bus provides exactly-once delivery semantics through idempotency keys and a write-ahead log. Messages are persisted for 14 days by default, extendable to 90 days with the retention add-on.",
    category: "product",
    lastUpdated: "2025-11-20",
  },
  {
    id: "qa-008",
    question: "What API rate limits apply?",
    answer:
      "Default rate limits are 100 requests per minute per API key. The API Rate Boost add-on increases this to 10,000 requests per minute. Enterprise customers can request custom limits through their TAM.",
    category: "api",
    lastUpdated: "2025-08-15",
  },
  {
    id: "qa-009",
    question: "How do I set up real-time alerts?",
    answer:
      "Install the Real-Time Alerts Module add-on, then configure alert rules in Settings > Alerts. Supported channels include Slack, PagerDuty, email, and custom webhooks. Each rule supports threshold, anomaly, or pattern-based triggers.",
    category: "product",
    lastUpdated: "2025-10-25",
  },
  {
    id: "qa-010",
    question: "What training resources are available?",
    answer:
      "HERB offers self-paced courses in HERB Academy (free for all tiers), live Training Workshops (two-day sessions), and the Executive Briefing for strategic alignment. Documentation is available at docs.herb.example.com.",
    category: "support",
    lastUpdated: "2025-09-10",
  },
  {
    id: "qa-011",
    question: "How does HERB handle data masking for PII?",
    answer:
      "The Data Masking Layer add-on provides column-level masking with role-based reveal policies. Admins define masking rules per field, and users with the appropriate role see the unmasked data while others see redacted values.",
    category: "security",
    lastUpdated: "2025-11-05",
  },
  {
    id: "qa-012",
    question: "Can I white-label the HERB dashboard?",
    answer:
      "Yes. The Custom Branding Kit add-on allows you to replace logos, adjust color themes, set a custom domain, and customize the login page. Changes propagate to all users within 5 minutes.",
    category: "product",
    lastUpdated: "2025-07-20",
  },
  {
    id: "qa-013",
    question: "What is the pricing model for HERB?",
    answer:
      "HERB uses a platform-plus-add-on model. Customers purchase a base platform license and add optional modules. Service engagements (implementation, training, reviews) are priced separately. Contact sales for volume discounts.",
    category: "billing",
    lastUpdated: "2025-12-01",
  },
  {
    id: "qa-014",
    question: "How do webhooks work in HERB?",
    answer:
      "The Webhook Relay add-on provides fan-out delivery with automatic retries, exponential backoff, a dead-letter queue for failed deliveries, and HMAC payload signing for verification on the receiving end.",
    category: "api",
    lastUpdated: "2025-10-10",
  },
  {
    id: "qa-015",
    question: "What ML capabilities does HERB provide?",
    answer:
      "HERB ML Studio supports the full ML lifecycle: data preparation, model training, A/B evaluation, one-click deployment, and production monitoring with drift detection. It integrates with popular frameworks like PyTorch and scikit-learn.",
    category: "product",
    lastUpdated: "2025-11-15",
  },
  {
    id: "qa-016",
    question: "How do I contact HERB support?",
    answer:
      "Starter and Business tier: submit tickets via the support portal (8 AM-8 PM ET). Premium Support customers have 24/7 access via phone, chat, and a dedicated Slack channel with a 1-hour response SLA.",
    category: "support",
    lastUpdated: "2025-09-01",
  },
  {
    id: "qa-017",
    question: "Does HERB support custom fields on entities?",
    answer:
      "Yes. The Custom Fields Extension add-on allows up to 500 custom fields per entity type. Fields are fully indexed for search and can be used in workflow conditions, reports, and API filters.",
    category: "product",
    lastUpdated: "2025-08-25",
  },
  {
    id: "qa-018",
    question: "What is the HERB sandbox environment?",
    answer:
      "The Sandbox Environment add-on provides an isolated staging instance with anonymized production-mirrored data. It resets nightly and supports full API parity with production for integration testing.",
    category: "infrastructure",
    lastUpdated: "2025-10-05",
  },
  {
    id: "qa-019",
    question: "How does HERB handle audit logging?",
    answer:
      "Every API call, user action, and system event is recorded in an immutable audit log. Standard retention is 1 year. The Advanced Audit Pack extends retention to 7 years with tamper-proof archival and compliance-ready exports.",
    category: "compliance",
    lastUpdated: "2025-11-25",
  },
  {
    id: "qa-020",
    question: "What integrations does HERB support out of the box?",
    answer:
      "HERB provides native connectors for Salesforce, HubSpot, Jira, Slack, Microsoft Teams, GitHub, AWS S3, GCS, and Snowflake. The Custom Integration Build service covers ERP, CRM, or proprietary systems not on the list.",
    category: "product",
    lastUpdated: "2025-12-01",
  },
] as const;
