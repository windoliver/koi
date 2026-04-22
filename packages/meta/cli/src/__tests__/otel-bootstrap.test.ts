import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { buildResource, parseOtelResourceAttributes } from "../otel-bootstrap.js";

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

  test("skips empty segments from trailing/double commas", () => {
    expect(parseOtelResourceAttributes("a=1,,b=2,")).toEqual({ a: "1", b: "2" });
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
