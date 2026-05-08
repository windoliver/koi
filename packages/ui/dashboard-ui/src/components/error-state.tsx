import type { ReactElement } from "react";

export function ErrorState({ message }: { message: string }): ReactElement {
  return (
    <div className="panel-state panel-state--error" role="alert">
      <p className="panel-state__title">Demo data unavailable</p>
      <p className="panel-state__message">{message}</p>
    </div>
  );
}
