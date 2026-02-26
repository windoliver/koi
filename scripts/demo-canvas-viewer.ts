#!/usr/bin/env bun

/**
 * Live Canvas Demo — starts a canvas API server + A2UI HTML viewer.
 *
 * Two servers:
 *   1. Canvas API on port 3100 — REST CRUD + SSE streaming
 *   2. Viewer on port 3101 — renders A2UI component trees as HTML
 *
 * Creates 3 demo surfaces (hello-world, dashboard, form) and prints
 * clickable URLs. The viewer auto-refreshes via SSE when surfaces
 * are updated through the API.
 *
 * Usage:
 *   bun scripts/demo-canvas-viewer.ts
 */

import {
  applySurfaceUpdate,
  componentId,
  createCanvasSurface,
  serializeSurface,
  surfaceId,
} from "../packages/canvas/src/index.js";
import type { KoiError, Result } from "../packages/core/src/index.js";
import type {
  CanvasAuthenticator,
  CanvasAuthResult,
} from "../packages/gateway/src/canvas-routes.js";
import { createCanvasServer } from "../packages/gateway/src/canvas-routes.js";
import { createCanvasSseManager } from "../packages/gateway/src/canvas-sse.js";
import { createInMemorySurfaceStore } from "../packages/gateway/src/canvas-store.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CANVAS_PORT = 3100;
const VIEWER_PORT = 3101;
const PREFIX = "/gateway/canvas";

// ---------------------------------------------------------------------------
// Accept-all authenticator (demo only)
// ---------------------------------------------------------------------------

const acceptAllAuth: CanvasAuthenticator = async (
  request: Request,
): Promise<Result<CanvasAuthResult, KoiError>> => {
  const header = request.headers.get("Authorization");
  if (header === null || !header.startsWith("Bearer ")) {
    return { ok: false, error: { code: "PERMISSION", message: "Unauthorized", retryable: false } };
  }
  return { ok: true, value: { agentId: "demo-agent" } };
};

// ---------------------------------------------------------------------------
// A2UI component tree -> HTML renderer
// ---------------------------------------------------------------------------

// Subset of SerializedSurface from @koi/canvas/serialize.ts
// (not exported — redeclared here for demo rendering)
interface SerializedComponent {
  readonly id: string;
  readonly type: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly children: readonly string[];
  readonly dataBinding?: string;
}

interface SerializedSurface {
  readonly id: string;
  readonly title?: string;
  readonly components: readonly SerializedComponent[];
  readonly dataModel: Readonly<Record<string, unknown>>;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// escapeHtml covers all attribute contexts (& < > " ')
const escapeAttr = escapeHtml;

// ---------------------------------------------------------------------------
// Per-component renderers (dispatch map keeps renderComponent < 50 lines)
// ---------------------------------------------------------------------------

type Props = Readonly<Record<string, unknown>>;

function renderText(props: Props): string {
  const text = typeof props.text === "string" ? escapeHtml(props.text) : "";
  const style = typeof props.style === "string" ? props.style : "body";
  if (style === "heading" || style === "title") return `<h2>${text}</h2>`;
  if (style === "subtitle") return `<h3>${text}</h3>`;
  if (style === "caption") return `<small>${text}</small>`;
  return `<p>${text}</p>`;
}

function renderImage(props: Props): string {
  const rawSrc = typeof props.src === "string" ? props.src : "";
  const src =
    rawSrc.startsWith("http://") || rawSrc.startsWith("https://") ? escapeAttr(rawSrc) : "";
  const alt = typeof props.alt === "string" ? escapeAttr(props.alt) : "";
  return `<img src="${src}" alt="${alt}" style="max-width:100%;border-radius:8px">`;
}

function renderButton(props: Props): string {
  const label = typeof props.label === "string" ? escapeHtml(props.label) : "Button";
  const variant = typeof props.variant === "string" ? props.variant : "primary";
  return `<button class="btn btn-${escapeAttr(variant)}">${label}</button>`;
}

function renderTextField(props: Props): string {
  const placeholder = typeof props.placeholder === "string" ? escapeAttr(props.placeholder) : "";
  const label = typeof props.label === "string" ? escapeHtml(props.label) : "";
  return label.length > 0
    ? `<label>${label}<br><input type="text" placeholder="${placeholder}" class="text-field"></label>`
    : `<input type="text" placeholder="${placeholder}" class="text-field">`;
}

function renderCheckBox(props: Props): string {
  const label = typeof props.label === "string" ? escapeHtml(props.label) : "";
  const checked = props.checked === true ? " checked" : "";
  return `<label class="checkbox"><input type="checkbox"${checked}> ${label}</label>`;
}

function renderSlider(props: Props): string {
  const min = typeof props.min === "number" ? props.min : 0;
  const max = typeof props.max === "number" ? props.max : 100;
  const label = typeof props.label === "string" ? escapeHtml(props.label) : "";
  return `<label>${label} <input type="range" min="${min}" max="${max}"></label>`;
}

function renderChoicePicker(props: Props): string {
  const label = typeof props.label === "string" ? escapeHtml(props.label) : "";
  const options = Array.isArray(props.options) ? props.options : [];
  const optionsHtml = options
    .map((o) => `<option>${typeof o === "string" ? escapeHtml(o) : ""}</option>`)
    .join("");
  return `<label>${label}<br><select>${optionsHtml}</select></label>`;
}

function renderDateTimeInput(props: Props): string {
  const label = typeof props.label === "string" ? escapeHtml(props.label) : "";
  return `<label>${label}<br><input type="datetime-local" class="text-field"></label>`;
}

type ComponentRenderer = (props: Props, childrenHtml: string) => string;

const RENDERERS: Readonly<Record<string, ComponentRenderer>> = {
  Row: (_p, ch) => `<div style="display:flex;gap:16px;align-items:flex-start">${ch}</div>`,
  Column: (_p, ch) => `<div style="display:flex;flex-direction:column;gap:12px">${ch}</div>`,
  Card: (_p, ch) => `<div class="card">${ch}</div>`,
  List: (_p, ch) => `<ul>${ch}</ul>`,
  Tabs: (_p, ch) => `<div class="tabs">${ch}</div>`,
  Modal: (_p, ch) => `<div class="modal">${ch}</div>`,
  Text: (p) => renderText(p),
  Image: (p) => renderImage(p),
  Icon: (p) =>
    `<span class="icon">[${typeof p.name === "string" ? escapeHtml(p.name) : "icon"}]</span>`,
  Divider: () => "<hr>",
  Button: (p) => renderButton(p),
  TextField: (p) => renderTextField(p),
  CheckBox: (p) => renderCheckBox(p),
  Slider: (p) => renderSlider(p),
  ChoicePicker: (p) => renderChoicePicker(p),
  DateTimeInput: (p) => renderDateTimeInput(p),
};

// ---------------------------------------------------------------------------
// Tree rendering
// ---------------------------------------------------------------------------

function renderComponent(
  comp: SerializedComponent,
  lookup: ReadonlyMap<string, SerializedComponent>,
  visited: ReadonlySet<string> = new Set(),
): string {
  if (visited.has(comp.id)) return `<!-- cycle: ${escapeHtml(comp.id)} -->`;
  const nextVisited = new Set([...visited, comp.id]);
  const childrenHtml = comp.children
    .map((childId) => {
      const child = lookup.get(childId);
      return child !== undefined ? renderComponent(child, lookup, nextVisited) : "";
    })
    .join("\n");

  const renderer = RENDERERS[comp.type];
  if (renderer !== undefined) return renderer(comp.properties, childrenHtml);
  return `<div class="unknown">[${escapeHtml(comp.type)}: ${escapeHtml(comp.id)}]</div>`;
}

function renderSurface(surface: SerializedSurface): string {
  const lookup = new Map(surface.components.map((c) => [c.id, c]));
  const roots = findRoots(surface.components);
  return roots.map((root) => renderComponent(root, lookup)).join("\n");
}

/** Find root components (those not referenced as children by any other component). */
function findRoots(components: readonly SerializedComponent[]): readonly SerializedComponent[] {
  const childIds = new Set<string>();
  for (const comp of components) {
    for (const childId of comp.children) {
      childIds.add(childId);
    }
  }
  return components.filter((c) => !childIds.has(c.id));
}

// ---------------------------------------------------------------------------
// HTML templates
// ---------------------------------------------------------------------------

const PAGE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         max-width: 900px; margin: 40px auto; padding: 0 20px; color: #1a1a2e;
         background: #f8f9fa; line-height: 1.6; }
  h1 { margin-bottom: 8px; }
  h2 { margin: 16px 0 8px; font-size: 1.3em; }
  h3 { margin: 12px 0 6px; font-size: 1.1em; color: #555; }
  p { margin: 6px 0; }
  hr { border: none; border-top: 1px solid #ddd; margin: 16px 0; }
  .card { border: 1px solid #e0e0e0; border-radius: 12px; padding: 20px;
          background: white; box-shadow: 0 2px 8px rgba(0,0,0,0.06); margin: 8px 0; }
  .btn { padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer;
         font-size: 14px; font-weight: 500; transition: background 0.2s; }
  .btn-primary { background: #4f46e5; color: white; }
  .btn-primary:hover { background: #4338ca; }
  .btn-secondary { background: #e5e7eb; color: #374151; }
  .btn-secondary:hover { background: #d1d5db; }
  .btn-danger { background: #ef4444; color: white; }
  .btn-danger:hover { background: #dc2626; }
  .text-field { padding: 10px 14px; border: 1px solid #d1d5db; border-radius: 8px;
                font-size: 14px; width: 100%; margin-top: 4px; }
  .text-field:focus { outline: none; border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79,70,229,0.1); }
  .checkbox { display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .checkbox input { width: 18px; height: 18px; }
  label { display: block; margin: 8px 0; font-weight: 500; }
  select { padding: 10px 14px; border: 1px solid #d1d5db; border-radius: 8px;
           font-size: 14px; width: 100%; margin-top: 4px; }
  .unknown { color: #888; font-style: italic; padding: 8px; border: 1px dashed #ccc; border-radius: 4px; }
  a { color: #4f46e5; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .surface-link { display: block; padding: 16px 20px; border: 1px solid #e0e0e0;
                  border-radius: 12px; background: white; margin: 8px 0;
                  box-shadow: 0 1px 4px rgba(0,0,0,0.04); transition: box-shadow 0.2s; }
  .surface-link:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-decoration: none; }
  .surface-link .name { font-weight: 600; font-size: 1.1em; }
  .surface-link .desc { color: #666; font-size: 0.9em; margin-top: 4px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px;
           background: #dbeafe; color: #1e40af; font-size: 0.75em; font-weight: 500; margin-left: 8px; }
  .sse-status { position: fixed; top: 12px; right: 16px; padding: 6px 12px; border-radius: 8px;
                font-size: 12px; font-weight: 500; }
  .sse-connected { background: #dcfce7; color: #166534; }
  .sse-disconnected { background: #fef2f2; color: #991b1b; }
`;

function indexPage(
  surfaces: readonly { readonly id: string; readonly description: string }[],
): string {
  const links = surfaces
    .map(
      (s) =>
        `<a href="/${s.id}" class="surface-link">
          <div class="name">${escapeHtml(s.id)} <span class="badge">A2UI</span></div>
          <div class="desc">${escapeHtml(s.description)}</div>
        </a>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Koi Canvas Viewer</title><style>${PAGE_CSS}</style></head>
<body>
<h1>Koi Canvas Viewer</h1>
<p>A2UI surfaces rendered as HTML. Click a surface to view it.</p>
<p style="color:#666;font-size:0.9em">Canvas API: <code>http://localhost:${CANVAS_PORT}${PREFIX}</code></p>
<hr>
${links}
</body></html>`;
}

function surfacePage(sid: string, renderedHtml: string, viewerPort: number): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(sid)} — Koi Canvas</title><style>${PAGE_CSS}</style></head>
<body>
<div style="margin-bottom:16px"><a href="/">&larr; Back to index</a></div>
<h1>${escapeHtml(sid)}</h1>
<div class="sse-status sse-disconnected" id="sse-badge">SSE: connecting...</div>
<hr>
<div id="surface-content">${renderedHtml}</div>
<script>
(function() {
  var badge = document.getElementById("sse-badge");
  var content = document.getElementById("surface-content");
  var surfaceId = ${JSON.stringify(sid)};
  var sseBase = "http://localhost:${viewerPort}/_sse";
  var es = new EventSource(sseBase + "/" + surfaceId);

  es.addEventListener("open", function() {
    badge.textContent = "SSE: connected";
    badge.className = "sse-status sse-connected";
  });

  es.addEventListener("updated", function() {
    fetch("/" + surfaceId + "?fragment=1")
      .then(function(r) { return r.text(); })
      .then(function(html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var frag = document.createDocumentFragment();
        while (doc.body.firstChild) frag.appendChild(doc.body.firstChild);
        content.replaceChildren(frag);
      });
  });

  es.addEventListener("deleted", function() {
    content.textContent = "Surface deleted.";
    badge.textContent = "SSE: surface deleted";
    badge.className = "sse-status sse-disconnected";
    es.close();
  });

  es.addEventListener("error", function() {
    badge.textContent = "SSE: disconnected";
    badge.className = "sse-status sse-disconnected";
  });
})();
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Demo surface definitions
// ---------------------------------------------------------------------------

function createHelloWorldSurface(): string {
  const surface = applySurfaceUpdate(createCanvasSurface(surfaceId("hello-world"), "Hello World"), [
    {
      id: componentId("card"),
      type: "Card",
      properties: {},
      children: [componentId("heading"), componentId("body")],
    },
    {
      id: componentId("heading"),
      type: "Text",
      properties: { text: "Hello, Canvas!", style: "heading" },
      children: [],
    },
    {
      id: componentId("body"),
      type: "Text",
      properties: {
        text: "This is a live A2UI surface rendered from the Koi canvas API. Edit it via PATCH and watch it update in real time.",
      },
      children: [],
    },
  ]);
  return serializeSurface(surface);
}

function createDashboardSurface(): string {
  const surface = applySurfaceUpdate(createCanvasSurface(surfaceId("dashboard"), "Dashboard"), [
    {
      id: componentId("row"),
      type: "Row",
      properties: {},
      children: [componentId("c1"), componentId("c2"), componentId("c3")],
    },
    {
      id: componentId("c1"),
      type: "Card",
      properties: {},
      children: [componentId("c1-title"), componentId("c1-value"), componentId("c1-btn")],
    },
    {
      id: componentId("c1-title"),
      type: "Text",
      properties: { text: "Active Agents", style: "caption" },
      children: [],
    },
    {
      id: componentId("c1-value"),
      type: "Text",
      properties: { text: "12", style: "heading" },
      children: [],
    },
    {
      id: componentId("c1-btn"),
      type: "Button",
      properties: { label: "View All", variant: "secondary" },
      children: [],
    },
    {
      id: componentId("c2"),
      type: "Card",
      properties: {},
      children: [componentId("c2-title"), componentId("c2-value"), componentId("c2-btn")],
    },
    {
      id: componentId("c2-title"),
      type: "Text",
      properties: { text: "Tasks Today", style: "caption" },
      children: [],
    },
    {
      id: componentId("c2-value"),
      type: "Text",
      properties: { text: "47", style: "heading" },
      children: [],
    },
    {
      id: componentId("c2-btn"),
      type: "Button",
      properties: { label: "Details", variant: "secondary" },
      children: [],
    },
    {
      id: componentId("c3"),
      type: "Card",
      properties: {},
      children: [componentId("c3-title"), componentId("c3-value"), componentId("c3-btn")],
    },
    {
      id: componentId("c3-title"),
      type: "Text",
      properties: { text: "Success Rate", style: "caption" },
      children: [],
    },
    {
      id: componentId("c3-value"),
      type: "Text",
      properties: { text: "98.5%", style: "heading" },
      children: [],
    },
    {
      id: componentId("c3-btn"),
      type: "Button",
      properties: { label: "Report", variant: "primary" },
      children: [],
    },
  ]);
  return serializeSurface(surface);
}

function createFormSurface(): string {
  const surface = applySurfaceUpdate(createCanvasSurface(surfaceId("form"), "Form"), [
    {
      id: componentId("col"),
      type: "Column",
      properties: {},
      children: [
        componentId("title"),
        componentId("name"),
        componentId("email"),
        componentId("divider"),
        componentId("notify"),
        componentId("submit"),
      ],
    },
    {
      id: componentId("title"),
      type: "Text",
      properties: { text: "Create Agent", style: "heading" },
      children: [],
    },
    {
      id: componentId("name"),
      type: "TextField",
      properties: { label: "Agent Name", placeholder: "e.g. research-assistant" },
      children: [],
    },
    {
      id: componentId("email"),
      type: "TextField",
      properties: { label: "Owner Email", placeholder: "you@example.com" },
      children: [],
    },
    { id: componentId("divider"), type: "Divider", properties: {}, children: [] },
    {
      id: componentId("notify"),
      type: "CheckBox",
      properties: { label: "Send notification on completion" },
      children: [],
    },
    {
      id: componentId("submit"),
      type: "Button",
      properties: { label: "Create Agent", variant: "primary" },
      children: [],
    },
  ]);
  return serializeSurface(surface);
}

interface DemoSurface {
  readonly id: string;
  readonly description: string;
  readonly content: string;
}

function createDemoSurfaces(): readonly DemoSurface[] {
  return [
    {
      id: "hello-world",
      description: "Simple card with heading and text",
      content: createHelloWorldSurface(),
    },
    {
      id: "dashboard",
      description: "Three-card dashboard layout with stats",
      content: createDashboardSurface(),
    },
    {
      id: "form",
      description: "Interactive form with text fields and checkbox",
      content: createFormSurface(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Viewer request handler
// ---------------------------------------------------------------------------

function handleViewerRequest(
  canvasBase: string,
  demos: readonly DemoSurface[],
  viewerPort: number,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;

    // Index page
    if (path === "/" || path === "") {
      return new Response(indexPage(demos), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // SSE proxy: /_sse/{surfaceId} → canvas API SSE (avoids CORS)
    if (path.startsWith("/_sse/")) {
      const sid = path.slice("/_sse/".length);
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sid)) {
        return new Response("Invalid surface ID", {
          status: 400,
          headers: { "Content-Type": "text/plain" },
        });
      }
      const upstream = await fetch(`${canvasBase}/${sid}/events`);
      if (!upstream.ok) {
        return new Response(`Upstream error: ${upstream.status}`, {
          status: upstream.status,
          headers: { "Content-Type": "text/plain" },
        });
      }
      return new Response(upstream.body, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Surface page: /{surfaceId}
    const sid = path.slice(1);
    if (sid.length === 0 || sid.includes("/")) {
      return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
    }

    return handleSurfacePage(canvasBase, sid, url, viewerPort);
  };
}

/** Type guard for the canvas API GET response shape. */
function isCanvasApiResponse(
  v: unknown,
): v is { readonly ok: boolean; readonly surface?: { readonly content?: string } } {
  if (typeof v !== "object" || v === null) return false;
  const rec = v as Readonly<Record<string, unknown>>;
  if (typeof rec.ok !== "boolean") return false;
  if (rec.surface !== undefined) {
    if (typeof rec.surface !== "object" || rec.surface === null) return false;
    const surf = rec.surface as Readonly<Record<string, unknown>>;
    if (surf.content !== undefined && typeof surf.content !== "string") return false;
  }
  return true;
}

async function handleSurfacePage(
  canvasBase: string,
  sid: string,
  url: URL,
  viewerPort: number,
): Promise<Response> {
  const apiRes = await fetch(`${canvasBase}/${sid}`);
  if (!apiRes.ok) {
    return new Response("Surface not found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const json: unknown = await apiRes.json();
  if (!isCanvasApiResponse(json) || !json.ok || json.surface?.content === undefined) {
    return new Response("Invalid surface data", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }

  let parsed: SerializedSurface;
  try {
    parsed = JSON.parse(json.surface.content) as SerializedSurface;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "parse error";
    return new Response(`Invalid surface JSON: ${msg}`, {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const rendered = renderSurface(parsed);

  // Fragment mode: return just the rendered HTML (for SSE refresh)
  if (url.searchParams.get("fragment") === "1") {
    return new Response(rendered, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  return new Response(surfacePage(sid, rendered, viewerPort), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// Curl example generator
// ---------------------------------------------------------------------------

function generatePatchExample(): string {
  const updated = applySurfaceUpdate(createCanvasSurface(surfaceId("hello-world"), "Hello World"), [
    { id: componentId("card"), type: "Card", properties: {}, children: [componentId("heading")] },
    {
      id: componentId("heading"),
      type: "Text",
      properties: { text: "UPDATED via PATCH!", style: "heading" },
      children: [],
    },
  ]);
  return serializeSurface(updated).replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Start canvas API server
  const store = createInMemorySurfaceStore();
  const sse = createCanvasSseManager({ keepAliveIntervalMs: 30_000 });
  const canvasServer = createCanvasServer(
    { port: CANVAS_PORT, pathPrefix: PREFIX },
    store,
    sse,
    acceptAllAuth,
  );
  await canvasServer.start();

  // 2. Create demo surfaces via the API
  const demos = createDemoSurfaces();
  const canvasBase = `http://localhost:${canvasServer.port()}${PREFIX}`;

  for (const demo of demos) {
    const res = await fetch(`${canvasBase}/${demo.id}`, {
      method: "POST",
      headers: { Authorization: "Bearer demo", "Content-Type": "application/json" },
      body: JSON.stringify({ content: demo.content }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to create surface '${demo.id}': ${res.status} ${body}`);
    }
  }

  // 3. Start viewer server (proxies SSE to avoid CORS issues, localhost-only)
  const viewerServer = Bun.serve({
    port: VIEWER_PORT,
    hostname: "127.0.0.1",
    fetch: handleViewerRequest(canvasBase, demos, VIEWER_PORT),
  });

  // 4. Print URLs
  console.log("\n  Canvas API:    http://localhost:%d%s", canvasServer.port(), PREFIX);
  console.log("  Viewer:        http://localhost:%d\n", viewerServer.port);
  console.log("  Surfaces:");
  for (const demo of demos) {
    console.log("    http://localhost:%d/%s  — %s", viewerServer.port, demo.id, demo.description);
  }
  console.log("\n  Try live-updating a surface:");
  console.log('    curl -X PATCH -H "Authorization: Bearer demo" \\');
  console.log('      -H "Content-Type: application/json" \\');
  console.log('      -d \'{"content":"%s"}\' \\', generatePatchExample());
  console.log("      http://localhost:%d%s/hello-world\n", canvasServer.port(), PREFIX);
  console.log("  Press Ctrl+C to stop.\n");

  // 5. Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n  Shutting down...");
    viewerServer.stop(true);
    canvasServer.stop();
    sse.dispose();
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});
