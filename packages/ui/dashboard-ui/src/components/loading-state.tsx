import type { ReactElement } from "react";

export function LoadingState({ label = "Loading dashboard..." }: { label?: string }): ReactElement {
  return (
    <div className="panel-state panel-state--loading" role="status" aria-live="polite">
      <span className="panel-state__dot" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}
