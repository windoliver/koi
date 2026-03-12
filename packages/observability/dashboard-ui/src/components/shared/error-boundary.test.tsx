import { describe, expect, test, beforeEach, spyOn } from "bun:test";
import { render } from "../../__tests__/setup.js";
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
    const { getByText } = render(
      <ErrorBoundary>
        <p>All good</p>
      </ErrorBoundary>,
    );
    expect(getByText("All good")).toBeDefined();
  });

  test("renders default fallback on error", () => {
    const { getByText } = render(
      <ErrorBoundary>
        <ThrowingComponent message="test crash" />
      </ErrorBoundary>,
    );
    expect(getByText("Something went wrong")).toBeDefined();
    expect(getByText("test crash")).toBeDefined();
  });

  test("renders custom fallback when provided", () => {
    const { getByText } = render(
      <ErrorBoundary fallback={<p>Custom error UI</p>}>
        <ThrowingComponent message="crash" />
      </ErrorBoundary>,
    );
    expect(getByText("Custom error UI")).toBeDefined();
  });
});
