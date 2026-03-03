import { describe, expect, test } from "bun:test";
import { createAnthropicDetector } from "./anthropic.js";
import { createAWSDetector } from "./aws.js";
import { createBasicAuthDetector } from "./basic-auth.js";
import { createBearerDetector } from "./bearer.js";
import { createCredentialURIDetector } from "./credential-uri.js";
import { createGenericSecretDetector } from "./generic-secret.js";
import { createGitHubDetector } from "./github.js";
import { createGoogleDetector } from "./google.js";
import { createAllSecretPatterns, DEFAULT_SENSITIVE_FIELDS } from "./index.js";
import { createJWTDetector } from "./jwt.js";
import { createOpenAIDetector } from "./openai.js";
import { createPEMDetector } from "./pem.js";
import { createSlackDetector } from "./slack.js";
import { createStripeDetector } from "./stripe.js";

describe("createJWTDetector", () => {
  const detector = createJWTDetector();

  test("detects JWT token", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123";
    const matches = detector.detect(jwt);
    expect(matches.length).toBe(1);
    expect(matches[0]?.kind).toBe("jwt");
  });

  test("returns empty for text without signal", () => {
    expect(detector.detect("no tokens here")).toEqual([]);
  });

  test("detects multiple JWTs", () => {
    const text = "first=eyJhbGciOiJIUzI1NiJ9.eyJhIn0.sig1 second=eyJhbGciOiJSUzI1NiJ9.eyJiIn0.sig2";
    const matches = detector.detect(text);
    expect(matches.length).toBe(2);
  });
});

describe("createAWSDetector", () => {
  const detector = createAWSDetector();

  test("detects AWS access key", () => {
    const matches = detector.detect("AKIAIOSFODNN7EXAMPLE");
    expect(matches.length).toBe(1);
    expect(matches[0]?.kind).toBe("aws_access_key");
  });

  test("returns empty without signal", () => {
    expect(detector.detect("not an AWS key")).toEqual([]);
  });
});

describe("createGitHubDetector", () => {
  const detector = createGitHubDetector();

  test("detects GitHub personal access token", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const matches = detector.detect(token);
    expect(matches.length).toBe(1);
    expect(matches[0]?.kind).toBe("github_token");
  });

  test("detects GitHub server token", () => {
    const token = `ghs_${"B".repeat(36)}`;
    const matches = detector.detect(token);
    expect(matches.length).toBe(1);
  });

  test("returns empty without signal", () => {
    expect(detector.detect("no github tokens")).toEqual([]);
  });
});

describe("createSlackDetector", () => {
  const detector = createSlackDetector();

  test("detects Slack bot token", () => {
    const token = "xoxb-1234567890-abcdefgh";
    const matches = detector.detect(token);
    expect(matches.length).toBe(1);
    expect(matches[0]?.kind).toBe("slack_token");
  });

  test("returns empty without signal", () => {
    expect(detector.detect("no slack tokens")).toEqual([]);
  });
});

describe("createStripeDetector", () => {
  const detector = createStripeDetector();

  test("detects Stripe secret key", () => {
    const key = `sk_live_${"a".repeat(24)}`;
    const matches = detector.detect(key);
    expect(matches.length).toBe(1);
    expect(matches[0]?.kind).toBe("stripe_key");
  });

  test("detects Stripe publishable key", () => {
    const key = `pk_live_${"b".repeat(24)}`;
    const matches = detector.detect(key);
    expect(matches.length).toBe(1);
  });

  test("returns empty without signal", () => {
    expect(detector.detect("no stripe keys")).toEqual([]);
  });
});

describe("createPEMDetector", () => {
  const detector = createPEMDetector();

  test("detects PEM private key", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJBALRiMLAHudeSA/x3hB2f+2NRkJLA\n-----END RSA PRIVATE KEY-----";
    const matches = detector.detect(pem);
    expect(matches.length).toBe(1);
    expect(matches[0]?.kind).toBe("pem_private_key");
  });

  test("returns empty without signal", () => {
    expect(detector.detect("no PEM keys")).toEqual([]);
  });
});

describe("createBearerDetector", () => {
  const detector = createBearerDetector();

  test("detects Bearer token", () => {
    const matches = detector.detect("Bearer abc123def456");
    expect(matches.length).toBe(1);
    expect(matches[0]?.kind).toBe("bearer_token");
  });

  test("returns empty without signal", () => {
    expect(detector.detect("no bearer tokens")).toEqual([]);
  });
});

describe("createBasicAuthDetector", () => {
  const detector = createBasicAuthDetector();

  test("detects Basic auth header", () => {
    const matches = detector.detect("Basic dXNlcjpwYXNz");
    expect(matches.length).toBe(1);
    expect(matches[0]?.kind).toBe("basic_auth");
  });

  test("returns empty without signal", () => {
    expect(detector.detect("no basic auth")).toEqual([]);
  });
});

describe("createOpenAIDetector", () => {
  const detector = createOpenAIDetector();

  test("detects sk-proj- key", () => {
    const key = `sk-proj-${"a".repeat(40)}`;
    const matches = detector.detect(key);
    expect(matches.length).toBe(1);
    expect(matches[0]?.kind).toBe("openai_api_key");
  });

  test("detects sk-svcacct- key", () => {
    const key = `sk-svcacct-${"b".repeat(40)}`;
    const matches = detector.detect(key);
    expect(matches.length).toBe(1);
  });

  test("detects sk-admin- key", () => {
    const key = `sk-admin-${"c".repeat(40)}`;
    const matches = detector.detect(key);
    expect(matches.length).toBe(1);
  });

  test("returns empty without signal", () => {
    expect(detector.detect("no openai keys")).toEqual([]);
  });

  test("ignores too-short value after prefix", () => {
    expect(detector.detect("sk-proj-short")).toEqual([]);
  });
});

describe("createAnthropicDetector", () => {
  const detector = createAnthropicDetector();

  test("detects sk-ant-api03- key", () => {
    const key = `sk-ant-api03-${"a".repeat(90)}`;
    const matches = detector.detect(key);
    expect(matches.length).toBe(1);
    expect(matches[0]?.kind).toBe("anthropic_api_key");
  });

  test("detects sk-ant-admin01- key", () => {
    const key = `sk-ant-admin01-${"b".repeat(90)}`;
    const matches = detector.detect(key);
    expect(matches.length).toBe(1);
  });

  test("returns empty without signal", () => {
    expect(detector.detect("no anthropic keys")).toEqual([]);
  });

  test("ignores too-short value after prefix", () => {
    // Needs 80-100 chars after prefix
    expect(detector.detect(`sk-ant-api03-${"x".repeat(10)}`)).toEqual([]);
  });
});

describe("createGoogleDetector", () => {
  const detector = createGoogleDetector();

  test("detects Google API key", () => {
    const key = `AIza${"a".repeat(35)}`;
    const matches = detector.detect(key);
    expect(matches.length).toBe(1);
    expect(matches[0]?.kind).toBe("google_api_key");
  });

  test("returns empty without signal", () => {
    expect(detector.detect("no google keys")).toEqual([]);
  });

  test("ignores too-short value after prefix", () => {
    expect(detector.detect("AIza_short")).toEqual([]);
  });
});

describe("createCredentialURIDetector", () => {
  const detector = createCredentialURIDetector();

  test("detects MongoDB connection string", () => {
    const uri = "mongodb://admin:s3cret@db.example.com:27017/mydb";
    const matches = detector.detect(uri);
    expect(matches.length).toBe(1);
    expect(matches[0]?.kind).toBe("credential_uri");
  });

  test("detects PostgreSQL connection string", () => {
    const uri = "postgresql://user:pass@localhost:5432/db";
    const matches = detector.detect(uri);
    expect(matches.length).toBe(1);
  });

  test("detects Redis connection string", () => {
    const uri = "redis://default:mypassword@cache.example.com:6379";
    const matches = detector.detect(uri);
    expect(matches.length).toBe(1);
  });

  test("detects MongoDB+SRV", () => {
    const uri = "mongodb+srv://user:pass@cluster.example.com/db";
    const matches = detector.detect(uri);
    expect(matches.length).toBe(1);
  });

  test("returns empty without signal", () => {
    expect(detector.detect("https://example.com")).toEqual([]);
  });

  test("ignores URI without credentials", () => {
    // No user:pass@ portion — pattern requires credentials
    expect(detector.detect("mongodb://localhost:27017/db")).toEqual([]);
  });
});

describe("createGenericSecretDetector", () => {
  const detector = createGenericSecretDetector();

  test("detects password= assignment", () => {
    const text = "password=my_super_secret_value";
    const matches = detector.detect(text);
    expect(matches.length).toBe(1);
    expect(matches[0]?.kind).toBe("generic_secret");
  });

  test("detects api_key: assignment", () => {
    const text = 'api_key: "abcdefghij1234567890"';
    const matches = detector.detect(text);
    expect(matches.length).toBe(1);
  });

  test("detects token= with quotes", () => {
    const text = "token='longvalue_abcdefgh'";
    const matches = detector.detect(text);
    expect(matches.length).toBe(1);
  });

  test("returns empty without signal keyword", () => {
    expect(detector.detect("username=admin")).toEqual([]);
  });

  test("ignores placeholder values", () => {
    expect(detector.detect("password=[REDACTED]")).toEqual([]);
    expect(detector.detect("password=changeme")).toEqual([]);
    expect(detector.detect("password=xxxxxxxx")).toEqual([]);
  });

  test("ignores short values (< 8 chars)", () => {
    expect(detector.detect("password=short")).toEqual([]);
  });

  test("detects multiple assignments", () => {
    const text = "password=abcdefghij token=klmnopqrst";
    const matches = detector.detect(text);
    expect(matches.length).toBe(2);
  });
});

describe("createAllSecretPatterns", () => {
  test("returns 13 patterns", () => {
    const patterns = createAllSecretPatterns();
    expect(patterns.length).toBe(13);
  });

  test("all patterns have name and kind", () => {
    for (const p of createAllSecretPatterns()) {
      expect(p.name).toBeTruthy();
      expect(p.kind).toBeTruthy();
      expect(typeof p.detect).toBe("function");
    }
  });
});

describe("DEFAULT_SENSITIVE_FIELDS", () => {
  test("contains password", () => {
    expect(DEFAULT_SENSITIVE_FIELDS).toContain("password");
  });

  test("contains apiKey", () => {
    expect(DEFAULT_SENSITIVE_FIELDS).toContain("apiKey");
  });

  test("has at least 25 entries", () => {
    expect(DEFAULT_SENSITIVE_FIELDS.length).toBeGreaterThanOrEqual(25);
  });
});
