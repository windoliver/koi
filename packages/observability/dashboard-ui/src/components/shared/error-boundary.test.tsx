import { describe, expect, test, beforeEach, spyOn } from "bun:test";
import { render, screen } from "../../__tests__/setup.js";
import { ErrorBoundary } from "./error-boundary.js";

function ThrowingComponent({ message }: { readonly message: string }): React.ReactElement {
  throw new Error(message);
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    // Suppress React error boundary console.error noise in test output
    spyOn(console, "error").mockImplementation(() => {});
  });

  test("renders children when no error", () => {
    render(
      <ErrorBoundary>
        <p>All good</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("All good")).toBeDefined();
  });

  test("renders default fallback on error", () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent message="test crash" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Something went wrong")).toBeDefined();
    expect(screen.getByText("test crash")).toBeDefined();
  });

  test("renders custom fallback when provided", () => {
    render(
      <ErrorBoundary fallback={<p>Custom error UI</p>}>
        <ThrowingComponent message="crash" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Custom error UI")).toBeDefined();
  });
});
