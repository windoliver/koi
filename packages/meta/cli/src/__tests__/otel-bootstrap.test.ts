import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  buildResource,
  parseOtelResourceAttributes,
  StderrSpanExporter,
} from "../otel-bootstrap.js";

// Snapshot and restore env vars touched by each test.
const ENV_KEYS = ["OTEL_SERVICE_NAME", "OTEL_RESOURCE_ATTRIBUTES", "KOI_VERSION"] as const;

type EnvSnapshot = Record<(typeof ENV_KEYS)[number], string | undefined>;

let snapshot: EnvSnapshot = {
  OTEL_SERVICE_NAME: undefined,
  OTEL_RESOURCE_ATTRIBUTES: undefined,
  KOI_VERSION: undefined,
};

beforeEach(() => {
  snapshot = {
    OTEL_SERVICE_NAME: undefined,
    OTEL_RESOURCE_ATTRIBUTES: undefined,
    KOI_VERSION: undefined,
  };
  for (const key of ENV_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const saved = snapshot[key];
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  }
});

describe("buildResource", () => {
  test("defaults: service.name=koi when no env vars set", () => {
    const resource = buildResource("headless");
    expect(resource.attributes["service.name"]).toBe("koi");
  });

  test("defaults: service.version omitted when KOI_VERSION unset", () => {
    const resource = buildResource("headless");
    // service.version must not default to a fake "dev" — omit it entirely so
    // unversioned builds don't collapse into a bogus version bucket in collectors.
    expect(resource.attributes["service.version"]).toBeUndefined();
  });

  test("defaults: koi.mode reflects bootstrap arg", () => {
    expect(buildResource("tui").attributes["koi.mode"]).toBe("tui");
    expect(buildResource("headless").attributes["koi.mode"]).toBe("headless");
  });

  test("defaults: process.runtime.name=bun", () => {
    const resource = buildResource("headless");
    expect(resource.attributes["process.runtime.name"]).toBe("bun");
  });

  test("defaults: process.runtime.version matches Bun.version", () => {
    const resource = buildResource("headless");
    expect(resource.attributes["process.runtime.version"]).toBe(Bun.version);
  });

  test("OTEL_SERVICE_NAME overrides service.name", () => {
    process.env.OTEL_SERVICE_NAME = "koi-staging";
    const resource = buildResource("headless");
    expect(resource.attributes["service.name"]).toBe("koi-staging");
  });

  test("OTEL_RESOURCE_ATTRIBUTES sets key=value pairs", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "deployment.environment=staging,region=us-east-1";
    const resource = buildResource("headless");
    expect(resource.attributes["deployment.environment"]).toBe("staging");
    expect(resource.attributes.region).toBe("us-east-1");
  });

  test("OTEL_RESOURCE_ATTRIBUTES overrides Koi defaults", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.version=1.2.3";
    const resource = buildResource("headless");
    expect(resource.attributes["service.version"]).toBe("1.2.3");
  });

  test("OTEL_SERVICE_NAME wins over OTEL_RESOURCE_ATTRIBUTES service.name", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.name=from-attrs";
    process.env.OTEL_SERVICE_NAME = "from-service-name";
    const resource = buildResource("headless");
    expect(resource.attributes["service.name"]).toBe("from-service-name");
  });

  test("malformed OTEL_RESOURCE_ATTRIBUTES discards entire value and warns", () => {
    // Fail-closed: one bad pair must discard everything, not partially apply
    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      if (typeof chunk === "string") stderrWrites.push(chunk);
      return true;
    };
    process.env.OTEL_RESOURCE_ATTRIBUTES = "valid=yes,bad-no-equals,other=ok";
    const resource = buildResource("headless");
    process.stderr.write = origWrite;

    // The valid pair must NOT be applied — entire value is discarded
    expect(resource.attributes.valid).toBeUndefined();
    expect(resource.attributes.other).toBeUndefined();
    // Operator must get a warning
    expect(stderrWrites.some((w) => w.includes("malformed"))).toBe(true);
  });

  test("percent-encoded OTEL_RESOURCE_ATTRIBUTES values are decoded", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "greeting=hello%20world";
    const resource = buildResource("headless");
    expect(resource.attributes.greeting).toBe("hello world");
  });

  test("KOI_VERSION sets service.version", () => {
    process.env.KOI_VERSION = "0.5.0";
    const resource = buildResource("headless");
    expect(resource.attributes["service.version"]).toBe("0.5.0");
  });

  test("whitespace-only OTEL_SERVICE_NAME is ignored — falls back to default", () => {
    process.env.OTEL_SERVICE_NAME = "   ";
    const resource = buildResource("headless");
    expect(resource.attributes["service.name"]).toBe("koi");
  });

  test("whitespace-only KOI_VERSION is ignored — service.version omitted", () => {
    // CI template vars that resolve to spaces (e.g. "   ") must not produce a
    // blank service.version bucket — omit it rather than restore a bad value.
    process.env.KOI_VERSION = "   ";
    const resource = buildResource("headless");
    expect(resource.attributes["service.version"]).toBeUndefined();
  });

  test("padded OTEL_SERVICE_NAME is trimmed — no split-bucket from surrounding spaces", () => {
    process.env.OTEL_SERVICE_NAME = "  koi-prod  ";
    const resource = buildResource("headless");
    expect(resource.attributes["service.name"]).toBe("koi-prod");
  });

  test("padded service.name from OTEL_RESOURCE_ATTRIBUTES is trimmed", () => {
    // %20koi-prod%20 decodes to " koi-prod " — must be normalized to "koi-prod"
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.name=%20koi-prod%20";
    const resource = buildResource("headless");
    expect(resource.attributes["service.name"]).toBe("koi-prod");
  });
});

describe("parseOtelResourceAttributes", () => {
  test("parses valid key=value pairs", () => {
    expect(parseOtelResourceAttributes("a=1,b=2")).toEqual({ a: "1", b: "2" });
  });

  test("decodes percent-encoded values", () => {
    expect(parseOtelResourceAttributes("greeting=hello%20world")).toEqual({
      greeting: "hello world",
    });
  });

  test("returns undefined for entry missing equals sign", () => {
    expect(parseOtelResourceAttributes("valid=yes,bad-no-equals,other=ok")).toBeUndefined();
  });

  test("returns undefined for entry with empty key", () => {
    expect(parseOtelResourceAttributes("=value")).toBeUndefined();
  });

  test("returns undefined for invalid percent-encoding", () => {
    expect(parseOtelResourceAttributes("key=%GG")).toBeUndefined();
  });

  test("allows empty values (spec-compliant: optional attributes may be empty)", () => {
    expect(parseOtelResourceAttributes("optional.tag=")).toEqual({ "optional.tag": "" });
  });

  test("returns undefined for foo=a=b (unencoded = in value not allowed — matches OTel JS EnvDetector)", () => {
    // The OTel JS EnvDetector uses split("=") and requires exactly 2 parts.
    // foo=a=b produces 3 parts → malformed. Use foo=a%3Db to encode the value "=".
    expect(parseOtelResourceAttributes("foo=a=b")).toBeUndefined();
  });

  test("accepts percent-encoded = in value (foo=a%3Db → {foo: 'a=b'})", () => {
    expect(parseOtelResourceAttributes("foo=a%3Db")).toEqual({ foo: "a=b" });
  });

  test("returns undefined for trailing or double commas (matches OTel JS EnvDetector fail-closed behavior)", () => {
    // OTel JS EnvDetector does NOT skip empty segments — it throws on any non key=value pair.
    expect(parseOtelResourceAttributes("a=1,,b=2")).toBeUndefined();
    expect(parseOtelResourceAttributes("a=1,b=2,")).toBeUndefined();
  });

  test("decodes percent-encoded keys", () => {
    expect(parseOtelResourceAttributes("my%20key=value")).toEqual({ "my key": "value" });
  });

  test("returns undefined for key exceeding 255 characters", () => {
    const longKey = "k".repeat(256);
    expect(parseOtelResourceAttributes(`${longKey}=value`)).toBeUndefined();
  });

  test("returns undefined for value exceeding 255 characters", () => {
    const longValue = "v".repeat(256);
    expect(parseOtelResourceAttributes(`key=${longValue}`)).toBeUndefined();
  });
});

describe("buildResource semantic key protection", () => {
  test("service.version= drops the override and warns", () => {
    process.env.KOI_VERSION = "1.0.0";
    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      if (typeof chunk === "string") stderrWrites.push(chunk);
      return true;
    };
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.version=";
    const resource = buildResource("headless");
    process.stderr.write = origWrite;

    // Empty override must be dropped — KOI_VERSION value must be preserved
    expect(resource.attributes["service.version"]).toBe("1.0.0");
    expect(stderrWrites.some((w) => w.includes("service.version"))).toBe(true);
  });

  test("service.name= in OTEL_RESOURCE_ATTRIBUTES falls back to default with warning", () => {
    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      if (typeof chunk === "string") stderrWrites.push(chunk);
      return true;
    };
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.name=";
    const resource = buildResource("headless");
    process.stderr.write = origWrite;

    // service.name must never be empty — fall back to "koi" with a warning
    expect(resource.attributes["service.name"]).toBe("koi");
    expect(stderrWrites.some((w) => w.includes("service.name"))).toBe(true);
  });

  test("non-service-name empty values are allowed (spec-compliant)", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "optional.tag=,region=us-east-1";
    const resource = buildResource("headless");
    expect(resource.attributes["optional.tag"]).toBe("");
    expect(resource.attributes.region).toBe("us-east-1");
    // service.name default must still be intact
    expect(resource.attributes["service.name"]).toBe("koi");
  });

  test("whitespace-only service.name via OTEL_RESOURCE_ATTRIBUTES falls back with warning", () => {
    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      if (typeof chunk === "string") stderrWrites.push(chunk);
      return true;
    };
    // %20 = space — parses to " " which is whitespace-only
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.name=%20";
    const resource = buildResource("headless");
    process.stderr.write = origWrite;

    expect(resource.attributes["service.name"]).toBe("koi");
    expect(stderrWrites.some((w) => w.includes("service.name"))).toBe(true);
  });
});

describe("buildResource integration: span carries resource attributes", () => {
  test("span.resource.attributes['service.name'] matches OTEL_SERVICE_NAME", () => {
    process.env.OTEL_SERVICE_NAME = "integration-test";
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      resource: buildResource("headless"),
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });

    provider.getTracer("test").startSpan("test-span").end();

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
    expect(spans[0]?.resource.attributes["service.name"]).toBe("integration-test");

    void provider.shutdown();
  });
});

describe("StderrSpanExporter: end-to-end serialized output", () => {
  test("emits parseable NDJSON with Koi identity keys and span fields", () => {
    process.env.OTEL_SERVICE_NAME = "e2e-stderr-test";
    process.env.OTEL_RESOURCE_ATTRIBUTES = "deployment.environment=prod";

    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      if (typeof chunk === "string") stderrLines.push(chunk);
      return true;
    };

    const exporter = new StderrSpanExporter();
    const provider = new BasicTracerProvider({
      resource: buildResource("headless"),
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.getTracer("test").startSpan("e2e-span").end();

    process.stderr.write = origWrite;
    void provider.shutdown();

    expect(stderrLines.length).toBeGreaterThan(0);
    const firstLine = stderrLines[0];
    if (firstLine === undefined) throw new Error("no stderr output");
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;

    // Span identity fields must be present
    expect(typeof parsed.traceId).toBe("string");
    expect(typeof parsed.spanId).toBe("string");
    expect(parsed.name).toBe("e2e-span");

    // Resource must include Koi identity keys
    const resource = parsed.resource as Record<string, unknown>;
    expect(resource["service.name"]).toBe("e2e-stderr-test");
    expect(resource["koi.mode"]).toBe("headless");

    // Operator-supplied attrs must NOT appear in stderr output —
    // they remain in the in-memory resource for OTLP export, but are
    // excluded from the default log stream to avoid accidental data leakage.
    expect(resource["deployment.environment"]).toBeUndefined();
  });

  test("otelDiag warnings are emitted as JSON lines (not plain text) to preserve NDJSON stream", () => {
    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      if (typeof chunk === "string") stderrWrites.push(chunk);
      return true;
    };
    process.env.OTEL_RESOURCE_ATTRIBUTES = "no-equals-sign";
    buildResource("headless");
    process.stderr.write = origWrite;

    expect(stderrWrites.length).toBe(1);
    // Must be valid JSON (not a plain text warning)
    const firstWrite = stderrWrites[0];
    if (firstWrite === undefined) throw new Error("no stderr output");
    const parsed = JSON.parse(firstWrite) as Record<string, unknown>;
    expect(parsed.level).toBe("warn");
    expect(parsed.source).toBe("koi/otel");
    expect(typeof parsed.msg).toBe("string");
    expect((parsed.msg as string).includes("malformed")).toBe(true);
  });
});
