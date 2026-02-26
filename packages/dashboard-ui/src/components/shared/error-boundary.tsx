/**
 * Error boundary — catches React rendering errors.
 */

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  readonly children: ReactNode;
  readonly fallback?: ReactNode;
}

interface State {
  readonly hasError: boolean;
  readonly error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  override readonly state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[dashboard-ui] React error boundary caught:", error, info);
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
            <p className="text-sm text-[var(--color-error)]">Something went wrong</p>
            <p className="text-xs text-[var(--color-muted)]">
              {this.state.error?.message}
            </p>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
