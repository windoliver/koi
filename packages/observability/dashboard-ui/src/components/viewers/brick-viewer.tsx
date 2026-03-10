/**
 * BrickViewer — renders Forge brick definition files.
 *
 * Shows brick metadata, parameters, and template in a structured layout.
 */

import { Blocks } from "lucide-react";

interface BrickData {
  readonly name?: string;
  readonly description?: string;
  readonly version?: string;
  readonly parameters?: readonly BrickParam[];
  readonly template?: string;
  readonly [key: string]: unknown;
}

interface BrickParam {
  readonly name?: string;
  readonly type?: string;
  readonly required?: boolean;
  readonly description?: string;
}

export function BrickViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  let brick: BrickData;
  try {
    brick = JSON.parse(content) as BrickData;
  } catch {
    return (
      <div className="p-4 text-sm text-red-500">Failed to parse brick: {path}</div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <Blocks className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">{brick.name ?? path.split("/").pop()}</span>
        {brick.version !== undefined && (
          <span className="text-xs text-[var(--color-muted)]">v{brick.version}</span>
        )}
      </div>
      <div className="flex-1 overflow-auto p-4">
        {brick.description !== undefined && (
          <p className="mb-4 text-sm text-[var(--color-muted)]">{brick.description}</p>
        )}

        {brick.parameters !== undefined && brick.parameters.length > 0 && (
          <div className="mb-4">
            <h3 className="mb-2 text-xs font-medium text-[var(--color-muted)]">Parameters</h3>
            <div className="grid gap-2">
              {brick.parameters.map((param, i) => (
                <div
                  key={param.name ?? i}
                  className="flex items-start gap-2 rounded border border-[var(--color-border)] p-2 text-xs"
                >
                  <span className="font-mono font-medium">{param.name ?? "?"}</span>
                  {param.type !== undefined && (
                    <span className="rounded bg-[var(--color-muted)]/10 px-1.5 py-0.5">
                      {param.type}
                    </span>
                  )}
                  {param.required === true && (
                    <span className="text-red-500">required</span>
                  )}
                  {param.description !== undefined && (
                    <span className="text-[var(--color-muted)]">{param.description}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {brick.template !== undefined && (
          <div>
            <h3 className="mb-2 text-xs font-medium text-[var(--color-muted)]">Template</h3>
            <pre className="overflow-auto rounded bg-[var(--color-muted)]/5 p-3 font-mono text-xs">
              {brick.template}
            </pre>
          </div>
        )}

        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-[var(--color-muted)]">Raw JSON</summary>
          <pre className="mt-2 overflow-auto rounded bg-[var(--color-muted)]/5 p-3 font-mono text-xs">
            {JSON.stringify(brick, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}
