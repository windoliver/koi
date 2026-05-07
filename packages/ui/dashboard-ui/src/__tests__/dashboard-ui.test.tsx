import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardApp } from "../app.js";

describe("DashboardApp", () => {
  test("renders the dashboard shell title", () => {
    const markup = renderToStaticMarkup(<DashboardApp />);

    expect(markup).toContain("Koi Dashboard");
  });
});
