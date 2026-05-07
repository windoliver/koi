import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DashboardApp } from "./app.js";
import "./index.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error("Dashboard root element not found.");
}

createRoot(container).render(
  <StrictMode>
    <DashboardApp />
  </StrictMode>,
);
