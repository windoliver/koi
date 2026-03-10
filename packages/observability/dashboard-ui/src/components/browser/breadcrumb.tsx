/**
 * Breadcrumb — shows the selected file path as clickable segments.
 */

import { ChevronRight } from "lucide-react";
import { useTreeStore } from "../../stores/tree-store.js";

export function pathSegments(path: string): readonly { readonly label: string; readonly path: string }[] {
  const parts = path.split("/").filter((p) => p.length > 0);
  const segments: { readonly label: string; readonly path: string }[] = [];
  let current = "";
  for (const part of parts) {
    current = `${current}/${part}`;
    segments.push({ label: part, path: current });
  }
  return segments;
}

export function Breadcrumb(): React.ReactElement {
  const selectedPath = useTreeStore((s) => s.selectedPath);
  const select = useTreeStore((s) => s.select);
  const setExpanded = useTreeStore((s) => s.setExpanded);

  if (selectedPath === null) {
    return (
      <div className="flex items-center gap-1 px-3 py-2 text-xs text-[var(--color-muted)]">
        No file selected
      </div>
    );
  }

  const segments = pathSegments(selectedPath);

  return (
    <div className="flex items-center gap-0.5 overflow-x-auto px-3 py-2 text-xs">
      <button
        type="button"
        onClick={() => select(null)}
        className="text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
      >
        /
      </button>
      {segments.map((seg, i) => (
        <span key={seg.path} className="flex items-center gap-0.5">
          <ChevronRight className="h-3 w-3 text-[var(--color-muted)]" />
          <button
            type="button"
            onClick={() => {
              if (i < segments.length - 1) {
                // Navigate to parent directory (always a directory)
                setExpanded(seg.path, true);
                select(seg.path, true);
              }
            }}
            className={
              i === segments.length - 1
                ? "font-medium text-[var(--color-foreground)]"
                : "text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
            }
          >
            {seg.label}
          </button>
        </span>
      ))}
    </div>
  );
}
