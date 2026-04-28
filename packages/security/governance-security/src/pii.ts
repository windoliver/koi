export type PiiKind = "email" | "ssn" | "api_key";

export interface PiiMatch {
  readonly kind: PiiKind;
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

export interface PiiDetector {
  readonly kind: string;
  readonly detect: (text: string) => readonly PiiMatch[];
}

function findAll(text: string, pattern: RegExp, kind: PiiKind): readonly PiiMatch[] {
  const results: PiiMatch[] = [];
  const re = new RegExp(pattern.source, `g${pattern.flags.replace("g", "")}`);
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    results.push({
      kind,
      value: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return results;
}

// email: local@domain.tld — RFC 5321 local-part (quoted or unquoted) + domain
const EMAIL_RE = /(?:[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+|"[^"\r\n]+")@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

// SSN: XXX-XX-XXXX or XXX XX XXXX or XXXXXXXXX (dashes or spaces optional)
const SSN_RE = /\b(?!000|666|9\d\d)\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4}\b/;

// API keys: common vendor prefixes + length-gated patterns
const API_KEY_PATTERNS: readonly RegExp[] = [
  /sk-(?:proj|svcacct)-[a-zA-Z0-9_-]{20,}|sk-[a-zA-Z0-9]{32,}/, // OpenAI
  /AKIA[0-9A-Z]{16}/, // AWS IAM
  /(?:gh[pousr]_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{22,})/, // GitHub PAT/app/fine-grained tokens
  /xox[baopr]-[0-9]{8,}-(?:[0-9]{8,}-)?[a-zA-Z0-9]{24,}/, // Slack tokens (3-part or 4-part)
];

export function createEmailDetector(): PiiDetector {
  return {
    kind: "email" as const,
    detect: (text) => findAll(text, EMAIL_RE, "email"),
  };
}

export function createSsnDetector(): PiiDetector {
  return {
    kind: "ssn" as const,
    detect: (text) => findAll(text, SSN_RE, "ssn"),
  };
}

export function createApiKeyDetector(): PiiDetector {
  return {
    kind: "api_key" as const,
    detect(text): readonly PiiMatch[] {
      const results: PiiMatch[] = [];
      for (const pattern of API_KEY_PATTERNS) {
        results.push(...findAll(text, pattern, "api_key"));
      }
      return results;
    },
  };
}

const DETECTOR_MAP: Readonly<Record<PiiKind, () => PiiDetector>> = {
  email: createEmailDetector,
  ssn: createSsnDetector,
  api_key: createApiKeyDetector,
};

export function createPiiDetector(kinds: readonly PiiKind[]): PiiDetector {
  const seen = new Set<PiiKind>();
  const detectors: PiiDetector[] = [];
  for (const kind of kinds) {
    if (!seen.has(kind)) {
      seen.add(kind);
      detectors.push(DETECTOR_MAP[kind]());
    }
  }

  const compositeKind = [...seen].join(",");

  return {
    kind: compositeKind,
    detect(text): readonly PiiMatch[] {
      return detectors.flatMap((d) => [...d.detect(text)]);
    },
  };
}
