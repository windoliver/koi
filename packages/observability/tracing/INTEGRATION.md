# Trace Debugger Integration

Koi emits OpenTelemetry traces for agent runs, middleware hooks, and tool calls.
This guide covers how to visualize those traces with common backends.

## Jaeger (self-hosted)

Start a local Jaeger instance with the OTLP HTTP receiver enabled:

```bash
docker run -d \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one
```

Configure Koi to export traces:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

View traces at [http://localhost:16686](http://localhost:16686).

## AgentPrism (agent-specific visualization)

AgentPrism provides React components purpose-built for agent trace inspection.

```bash
bun add agent-prism
```

It works with any OTLP-compatible collector — point it at the same endpoint
Koi exports to and it renders agent-aware flame graphs, tool call timelines,
and middleware waterfall views.

## OTel Collector

For production deployments, run an OpenTelemetry Collector between Koi and
your trace backend. Example `otel-collector-config.yaml`:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

exporters:
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlp/jaeger]
```

Start the collector:

```bash
docker run -d \
  -p 4318:4318 \
  -v ./otel-collector-config.yaml:/etc/otelcol/config.yaml \
  otel/opentelemetry-collector
```

Then point Koi at the collector:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```
