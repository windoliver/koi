/**
 * ManifestViewer — renders agent manifest.json files with structured display.
 *
 * Shows key fields (name, type, engine, channels, skills) in a card layout
 * rather than raw JSON.
 */

import { Settings, Cpu, MessageSquare, Wrench } from "lucide-react";

interface ManifestData {
  readonly name?: string;
  readonly agentType?: string;
  readonly engine?: string;
  readonly model?: string;
  readonly channels?: readonly string[];
  readonly skills?: readonly string[];
  readonly middleware?: readonly string[];
  readonly [key: string]: unknown;
}

export function ManifestViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  let manifest: ManifestData;
  try {
    manifest = JSON.parse(content) as ManifestData;
  } catch {
    return (
      <div className="p-4 text-sm text-red-500">
        Failed to parse manifest: {path}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <Settings className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">
          {manifest.name ?? path.split("/").pop()}
        </span>
        {manifest.agentType !== undefined && (
          <span className="rounded bg-[var(--color-primary)]/10 px-2 py-0.5 text-xs text-[var(--color-primary)]">
            {manifest.agentType}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-auto p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {manifest.engine !== undefined && (
            <InfoCard icon={Cpu} label="Engine" value={manifest.engine} />
          )}
          {manifest.model !== undefined && (
            <InfoCard icon={Cpu} label="Model" value={manifest.model} />
          )}
          {manifest.channels !== undefined && manifest.channels.length > 0 && (
            <ListCard
              icon={MessageSquare}
              label="Channels"
              items={manifest.channels}
            />
          )}
          {manifest.skills !== undefined && manifest.skills.length > 0 && (
            <ListCard icon={Wrench} label="Skills" items={manifest.skills} />
          )}
          {manifest.middleware !== undefined && manifest.middleware.length > 0 && (
            <ListCard
              icon={Settings}
              label="Middleware"
              items={manifest.middleware}
            />
          )}
        </div>
        <details className="mt-6">
          <summary className="cursor-pointer text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)]">
            Raw JSON
          </summary>
          <pre className="mt-2 overflow-auto rounded bg-[var(--color-muted)]/5 p-3 font-mono text-xs">
            {JSON.stringify(manifest, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}

function InfoCard({
  icon: Icon,
  label,
  value,
}: {
  readonly icon: React.ElementType;
  readonly label: string;
  readonly value: string;
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-[var(--color-border)] p-3">
      <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-1 text-sm font-medium">{value}</div>
    </div>
  );
}

function ListCard({
  icon: Icon,
  label,
  items,
}: {
  readonly icon: React.ElementType;
  readonly label: string;
  readonly items: readonly string[];
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-[var(--color-border)] p-3">
      <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
        <Icon className="h-3.5 w-3.5" />
        {label} ({items.length})
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {items.map((item) => (
          <span
            key={item}
            className="rounded bg-[var(--color-muted)]/10 px-2 py-0.5 text-xs"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}
