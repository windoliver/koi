import type { ReactElement } from "react";

export function EmptyState({
  title,
  message,
}: {
  title: string;
  message: string;
}): ReactElement {
  return (
    <div className="panel-state">
      <p className="panel-state__title">{title}</p>
      <p className="panel-state__message">{message}</p>
    </div>
  );
}
