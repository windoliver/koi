# @koi/canvas — A2UI Headless Canvas Protocol

Implements Google's A2UI v0.9 specification as a headless protocol layer for agent-generated UIs. Provides types, validation, serialization, and event integration so Koi agents can dynamically build rich interactive surfaces — forms, dashboards, data views — that render in any compatible frontend.

---

## Why It Exists

LLM agents return text. But many tasks need structured UI — a form to fill, a dashboard to monitor, a table to sort. Without this package, every agent would hand-roll its own UI format, validation, and serialization.

`@koi/canvas` standardizes agent-to-UI communication using A2UI, a protocol with 18 component types, JSON Pointer data bindings, and immutable surface operations. The agent builds UI declaratively; the frontend renders it.

---

## What This Enables

### Agents Build UIs Dynamically

```
WITHOUT CANVAS                          WITH CANVAS
────────────────                        ───────────

Agent: "Here's the data                Agent: "I'll build you a form."
 you asked for:
                                       ┌─────────────────────────────┐
 Name: Alice                           │  ┌─── Form Surface ──────┐ │
 Email: alice@co.com                   │  │                        │ │
 Role: Admin                           │  │  Name:  [Alice      ]  │ │
                                       │  │  Email: [alice@co   ]  │ │
 ...want me to format that?"           │  │  Role:  [▼ Admin    ]  │ │
                                       │  │                        │ │
 (plain text — no interactivity)       │  │  [Save]    [Cancel]   │ │
                                       │  └────────────────────────┘ │
                                       └─────────────────────────────┘

                                        (interactive — user edits inline,
                                         agent sees changes via dataModel)
```

### A2UI Message Lifecycle

```
┌─────────────┐                                              ┌──────────────┐
│  KOI AGENT  │                                              │   FRONTEND   │
│             │  createSurface                               │   (AG-UI /   │
│  "Build a   │─────────────────────────────────────────────►│   CopilotKit)│
│   signup    │  { surfaceId, title, components, dataModel }  │              │
│   form"     │                                              │  ┌────────┐  │
│             │                                              │  │ Sign Up│  │
│             │  updateDataModel                             │  │        │  │
│  "User      │─────────────────────────────────────────────►│  │ Name:  │  │
│   typed     │  { pointer: "/name", value: "Alice" }        │  │ [    ] │  │
│   Alice"    │                                              │  │        │  │
│             │  updateComponents                            │  │ Email: │  │
│  "Add an    │─────────────────────────────────────────────►│  │ [    ] │  │
│   error     │  { components: [TextField with error] }      │  │        │  │
│   message"  │                                              │  │[Submit]│  │
│             │  deleteSurface                               │  └────────┘  │
│  "Done,     │─────────────────────────────────────────────►│  (removed)   │
│   clean up" │  { surfaceId: "s1" }                         │              │
└─────────────┘                                              └──────────────┘
```

### Component Tree Structure

```
CanvasSurface "s1" — "User Profile"
│
├── Row (layout)
│   ├── Column
│   │   ├── Text "Name"
│   │   └── TextField [ref=/name] ◄── dataBinding to dataModel
│   └── Column
│       ├── Text "Email"
│       └── TextField [ref=/email]
│
├── Card (layout)
│   ├── Text "Preferences"
│   ├── CheckBox "Dark Mode" [ref=/prefs/dark]
│   └── Slider "Font Size" [ref=/prefs/fontSize]
│
└── Row (layout)
    ├── Button "Save"
    └── Button "Cancel"


dataModel (live state):
{
  "name": "Alice",
  "email": "alice@acme.com",
  "prefs": { "dark": true, "fontSize": 14 }
}

Components stored as: ReadonlyMap<ComponentId, CanvasElement>  (O(1) lookup)
Data bindings use RFC 6901 JSON Pointers: "/prefs/dark"
```

---

## Architecture

`@koi/canvas` is an **L2 feature package** — it depends only on `@koi/core` (L0) and `@koi/validation` (L0u), plus `zod` for schema validation.

```
┌─────────────────────────────────────────────────────┐
│  @koi/canvas  (L2)                                  │
│                                                     │
│  types.ts              ← A2UI types, branded IDs     │
│  config.ts             ← CanvasConfig + defaults     │
│  events.ts             ← EngineEvent wrappers        │
│  mappers.ts            ← A2UI ↔ Canvas converters    │
│  serialize.ts          ← JSON serialization          │
│  surface.ts            ← immutable surface ops       │
│  schemas.ts            ← Zod schemas (private)       │
│  validate-canvas.ts    ← top-level validators        │
│  validate-surface.ts   ← tree semantic checks        │
│  validate-data-model.ts ← RFC 6901 JSON Pointer     │
│  index.ts              ← public API surface          │
│                                                     │
├─────────────────────────────────────────────────────┤
│  Dependencies                                       │
│                                                     │
│  @koi/core        (L0)   JsonObject, EngineEvent,   │
│                           ContentBlock, Result, etc. │
│  @koi/validation  (L0u)  validateWith() wrapper      │
│  zod              (ext)  schema validation           │
└─────────────────────────────────────────────────────┘
```

---

## 18 A2UI Component Types

```
┌─────────────────────────────────────────────────────────────┐
│                    A2UI v0.9 COMPONENT CATALOG               │
│                                                              │
│  LAYOUT (6)              DISPLAY (6)         INPUT (6)       │
│  ─────────               ──────────          ─────────       │
│  ┌─────────┐            ┌──────────┐        ┌──────────┐    │
│  │ Row     │  ← flex    │ Text     │        │ TextField│    │
│  │ Column  │  ← stack   │ Image    │        │ CheckBox │    │
│  │ List    │  ← repeat  │ Icon     │        │ DateTime │    │
│  │ Card    │  ← group   │ Video    │        │  Input   │    │
│  │ Tabs    │  ← switch  │ Audio    │        │ Choice   │    │
│  │ Modal   │  ← overlay │  Player  │        │  Picker  │    │
│  └─────────┘            │ Divider  │        │ Slider   │    │
│                          └──────────┘        │ Button   │    │
│                                              └──────────┐    │
│                                                              │
│  categorizeComponent("TextField") → "input"                  │
│  categorizeComponent("Card")      → "layout"                │
│  categorizeComponent("Image")     → "display"               │
└─────────────────────────────────────────────────────────────┘
```

---

## Data Flow Through Koi

```
┌──────────┐    A2uiMessage     ┌───────────────┐    EngineEvent     ┌────────────┐
│          │───────────────────►│               │──────────────────►│            │
│  Agent   │  createSurface     │  @koi/canvas  │  kind: "custom"   │ Middleware  │
│  (tool   │  updateComponents  │               │  type: "a2ui:*"   │ Chain      │
│   call)  │  updateDataModel   │  createCanvas │                   │            │
│          │  deleteSurface     │  Event()      │                   │            │
└──────────┘                    └───────────────┘                   └──────┬─────┘
                                                                          │
                                       ┌──────────────────────────────────┘
                                       │
                                       ▼
                                ┌──────────────┐   SSE / WebSocket   ┌──────────┐
                                │   Channel    │────────────────────►│ Frontend │
                                │  (@koi/agui) │   CustomBlock       │ (React / │
                                │              │   { kind: "custom", │ CopilotKit)
                                │  extract     │     type: "a2ui:*", │          │
                                │  CanvasMsg() │     data: {...} }   │  Renders │
                                └──────────────┘                     └──────────┘
```

### Multi-Channel Delivery (Future — see #415–#418)

```
Agent emits A2uiCreateSurface
       │
       ├── Channel supports A2UI? (CopilotKit web)
       │   └── Render natively via SSE (full richness)
       │
       └── Channel is text-only? (Slack, Telegram, CLI)
           └── Store in Gateway → send link
               "Here's your form: https://koi.app/canvas/s1"
```

---

## Immutable Surface Operations

```
createCanvasSurface(id)
  │
  │  Surface "s1"
  │  ┌──────────────────┐
  │  │ components: {}   │ (empty Map)
  │  │ dataModel: {}    │
  │  └──────────────────┘
  │
  ▼
applySurfaceUpdate(surface, components)
  │
  │  Surface "s1" (NEW object — original unchanged)
  │  ┌──────────────────┐
  │  │ components:       │
  │  │   Row → {Row}     │
  │  │   Name → {Field}  │
  │  │   Submit → {Btn}  │
  │  │ dataModel: {}     │
  │  └──────────────────┘
  │
  ▼
applyDataModelUpdate(surface, [{ pointer: "/name", value: "Alice" }])
  │
  │  Surface "s1" (NEW object)
  │  ┌──────────────────┐
  │  │ components: (same)│
  │  │ dataModel:        │
  │  │   { name: "Alice" }│
  │  └──────────────────┘
  │
  ▼
getComponent(surface, componentId("Name"))
  │
  │  → CanvasElement { id: "Name", type: "TextField", ... }
  │    O(1) lookup from ReadonlyMap
```

---

## Validation Pipeline

```
Raw input (unknown)
  │
  ▼
┌──────────────────────────────────────────┐
│  Layer 1: Zod Schema Validation          │
│                                          │
│  ✓ Component type is one of 18 literals  │
│  ✓ Message kind is discriminated union   │
│  ✓ Required fields present               │
│  ✓ Array constraints met                 │
│                                          │
│  Fail → VALIDATION error with Zod path   │
└──────────────────┬───────────────────────┘
                   │ pass
                   ▼
┌──────────────────────────────────────────┐
│  Layer 2: Semantic Validation            │
│                                          │
│  ✓ No duplicate component IDs            │
│  ✓ No dangling child references          │
│  ✓ No cycles in tree (iterative DFS)     │
│  ✓ Component count ≤ maxComponents       │
│  ✓ Tree depth ≤ maxTreeDepth             │
│                                          │
│  Fail → VALIDATION error with details    │
└──────────────────┬───────────────────────┘
                   │ pass
                   ▼
  Result<A2uiMessage, KoiError>
    { ok: true, value: validated }
```

### Cycle Detection

```
validateSurfaceComponents detects:

  Self-cycle:           Mutual cycle:         Transitive:
  ┌───┐                 ┌───┐   ┌───┐        ┌─A─┐
  │ A │──► A            │ A │──►│ B │        │   │──► B ──► C ──┐
  └───┘                 └───┘◄──└───┘        └───┘              │
  ✗ REJECTED            ✗ REJECTED            ◄─────────────────┘
                                              ✗ REJECTED

  Algorithm: Iterative DFS with 3-state coloring
  State: 0=unvisited, 1=in-progress, 2=done
  Depth limit: maxTreeDepth (default 50)
```

---

## JSON Pointer Data Binding (RFC 6901)

```
Component                    dataModel                  Rendered value
─────────                    ─────────                  ──────────────

TextField                    {
  dataBinding: "/user/name"    "user": {                  "Alice"
                                 "name": "Alice",
CheckBox                        "prefs": {
  dataBinding: "/user/           "dark": true           ☑ checked
                prefs/dark"    }
Slider                        }
  dataBinding: "/user/       }                           14
                prefs/fontSize"

Pointer parsing:
  "/user/prefs/dark"  →  tokens: ["user", "prefs", "dark"]

  Escape sequences (RFC 6901):
    ~0 → ~       (literal tilde)
    ~1 → /       (literal slash)

  ""   → root pointer (entire dataModel)
  "/"  → key "" at root (empty string key)
```

---

## Event Integration

```
A2UI messages wrap as EngineEvents with "a2ui:" prefix:

  createCanvasEvent({ kind: "createSurface", ... })
  → EngineEvent { kind: "custom", type: "a2ui:createSurface", data: {...} }

  createCanvasEvent({ kind: "updateDataModel", ... })
  → EngineEvent { kind: "custom", type: "a2ui:updateDataModel", data: {...} }

  isCanvasEvent(event)
  → true if event.type starts with "a2ui:"

  extractCanvasMessage(event)
  → Result<A2uiMessage, KoiError>

Flow through middleware:

  Agent ──► createCanvasEvent() ──► EngineEvent ──► middleware chain
                                                        │
                                              any middleware can:
                                              - filter (isCanvasEvent)
                                              - transform
                                              - log/audit
                                              - pass through
                                                        │
                                                        ▼
                                              Channel ──► extractCanvasMessage()
                                                         ──► render
```

---

## Bidirectional Mappers

```
A2UI Protocol ◄──────────────────────────────► Koi Internal
(wire format)                                  (runtime format)

A2uiComponent  ◄── mapA2uiComponent() ───────► CanvasElement
               ──► mapCanvasElement() ────────►

A2uiCreate     ◄── mapCreateSurfaceToCanvas() ► CanvasSurface
Surface        ──► mapCanvasToCreateSurface() ►

ContentBlock   ◄── mapContentBlockToElement() ► CanvasElement
(custom kind)  ──► mapElementToContentBlock() ►

Key differences:
  A2uiComponent.properties  → optional (undefined)
  CanvasElement.properties   → required (defaults to {})

  A2uiComponent.children     → optional (undefined)
  CanvasElement.children      → required (defaults to [])
```

---

## Serialization

```
CanvasSurface (runtime)                    JSON (storage/wire)
─────────────────────                      ────────────────────

{                                          {
  id: "s1" (SurfaceId),                      "id": "s1",
  title: "Form",                             "title": "Form",
  components: ReadonlyMap {      ──►         "components": [
    "c1" → { id, type, ... },                  { "id": "c1", ... },
    "c2" → { id, type, ... },                  { "id": "c2", ... }
  },                                         ],
  dataModel: { name: "Alice" }               "dataModel": { "name": "Alice" }
}                                          }

  serializeSurface()  → Map → array (compact JSON)
  deserializeSurface() → array → Map (O(1) lookups restored)

  Round-trip: surface → JSON → surface (identity-preserving)
  Branded IDs preserved as strings (safe — string-based)
  Optional fields omitted for compactness
```

---

## Configuration

```
CanvasConfig (with defaults):

  maxComponents:      1,000      Max elements per surface
  maxTreeDepth:          50      Max nesting depth
  maxSurfaces:          100      Max concurrent surfaces
  maxSerializedBytes: 1 MiB      Max JSON size

  Validated with Zod; all fields must be positive integers.
  DEFAULT_CANVAS_CONFIG is frozen (Object.freeze).
```

---

## Dashboard Example

```
Agent: "Show me a sales dashboard"

  ┌─────────────────────────────────────────────────────┐
  │  Surface: "Sales Dashboard"                          │
  │                                                      │
  │  ┌─── Tabs ──────────────────────────────────────┐  │
  │  │  [Overview]  [By Region]  [By Product]         │  │
  │  │                                                │  │
  │  │  ┌── Row ─────────────────────────────────┐   │  │
  │  │  │  ┌── Card ────┐  ┌── Card ────┐       │   │  │
  │  │  │  │ Revenue    │  │ Orders     │       │   │  │
  │  │  │  │ Text       │  │ Text       │       │   │  │
  │  │  │  │ "$1.2M"    │  │ "3,847"    │       │   │  │
  │  │  │  │ [/revenue] │  │ [/orders]  │       │   │  │
  │  │  │  └────────────┘  └────────────┘       │   │  │
  │  │  └────────────────────────────────────────┘   │  │
  │  │                                                │  │
  │  │  ┌── List ────────────────────────────────┐   │  │
  │  │  │  Row: "North America"  "$540K"         │   │  │
  │  │  │  Row: "Europe"         "$380K"         │   │  │
  │  │  │  Row: "Asia Pacific"   "$280K"         │   │  │
  │  │  └────────────────────────────────────────┘   │  │
  │  └────────────────────────────────────────────────┘  │
  │                                                      │
  │  dataModel: { revenue: "$1.2M", orders: "3,847" }   │
  │                                                      │
  │  Agent updates live:                                 │
  │    updateDataModel → { pointer: "/revenue",          │
  │                        value: "$1.3M" }              │
  │    → Frontend re-renders the Card automatically      │
  └─────────────────────────────────────────────────────┘
```

---

## Examples

### Create and Update a Surface

```typescript
import {
  createCanvasSurface,
  applySurfaceUpdate,
  applyDataModelUpdate,
  surfaceId,
  componentId,
} from "@koi/canvas";

// 1. Create empty surface
const surface = createCanvasSurface(surfaceId("s1"), "Sign Up");

// 2. Add components (immutable — returns new surface)
const withForm = applySurfaceUpdate(surface, [
  {
    id: componentId("row"),
    type: "Row",
    children: [componentId("name"), componentId("submit")],
  },
  {
    id: componentId("name"),
    type: "TextField",
    properties: { label: "Name" },
    dataBinding: "/name",
  },
  {
    id: componentId("submit"),
    type: "Button",
    properties: { label: "Submit" },
  },
]);

// 3. Update data model (immutable)
const result = applyDataModelUpdate(withForm, [
  { pointer: "/name", value: "Alice" },
]);
if (result.ok) {
  console.log(result.value.dataModel); // { name: "Alice" }
}
```

### Emit as EngineEvent

```typescript
import { createCanvasEvent, isCanvasEvent, extractCanvasMessage } from "@koi/canvas";
import type { A2uiCreateSurface } from "@koi/canvas";

// Wrap A2UI message as EngineEvent
const msg: A2uiCreateSurface = {
  kind: "createSurface",
  surfaceId: surfaceId("s1"),
  title: "Dashboard",
  components: [/* ... */],
  dataModel: { revenue: "$1.2M" },
};
const event = createCanvasEvent(msg);
// → { kind: "custom", type: "a2ui:createSurface", data: msg }

// In middleware or channel:
if (isCanvasEvent(event)) {
  const extracted = extractCanvasMessage(event);
  if (extracted.ok) {
    // extracted.value is the original A2uiMessage
  }
}
```

### Validate Input

```typescript
import { validateCreateSurface, validateSurfaceComponents } from "@koi/canvas";

// Full validation: Zod schema + semantic checks
const result = validateCreateSurface(rawInput, { maxComponents: 500 });
if (!result.ok) {
  console.error(result.error.message);
  // "Duplicate component id: c1"
  // "Dangling child reference: c99"
  // "Cycle detected at component: row"
}
```

### Serialize for Storage

```typescript
import { serializeSurface, deserializeSurface } from "@koi/canvas";

const json = serializeSurface(surface);   // Map → JSON array
const restored = deserializeSurface(json); // JSON → Map (round-trip)
if (restored.ok) {
  // restored.value is identical to original surface
}
```

---

## API Reference

### Factory Functions

| Function | Returns | Purpose |
|----------|---------|---------|
| `createCanvasSurface(id, title?)` | `CanvasSurface` | Empty surface |
| `createCanvasEvent(message)` | `EngineEvent` | Wrap A2UI as event |

### Surface Operations (Immutable)

| Function | Returns | Purpose |
|----------|---------|---------|
| `applySurfaceUpdate(surface, components)` | `CanvasSurface` | Upsert components |
| `applyDataModelUpdate(surface, updates)` | `Result<CanvasSurface, KoiError>` | Update data via JSON Pointer |
| `getComponent(surface, id)` | `CanvasElement \| undefined` | O(1) lookup |

### Mappers

| Function | Direction | Purpose |
|----------|-----------|---------|
| `mapA2uiComponent(c)` | A2UI → Canvas | Protocol to internal |
| `mapCanvasElement(e)` | Canvas → A2UI | Internal to protocol |
| `mapContentBlockToElement(b)` | ContentBlock → Canvas | Message integration |
| `mapElementToContentBlock(e)` | Canvas → ContentBlock | Message integration |
| `mapCreateSurfaceToCanvas(msg)` | A2UI → Canvas | Full surface conversion |
| `mapCanvasToCreateSurface(s)` | Canvas → A2UI | Full surface conversion |

### Validation

| Function | Returns | Purpose |
|----------|---------|---------|
| `validateA2uiMessage(raw)` | `Result<A2uiMessage, KoiError>` | Zod schema only |
| `validateCreateSurface(raw, config?)` | `Result<A2uiCreateSurface, KoiError>` | Zod + semantic |
| `validateSurfaceComponents(components, config?)` | `Result<true, KoiError>` | Tree invariants |
| `validateCanvasConfig(raw)` | `Result<CanvasConfig, KoiError>` | Config validation |
| `parseJsonPointer(pointer)` | `Result<JsonPointerTokens, KoiError>` | RFC 6901 |
| `isValidJsonPointer(pointer)` | `boolean` | Quick check |

### Serialization

| Function | Returns | Purpose |
|----------|---------|---------|
| `serializeSurface(surface)` | `string` | Map → JSON |
| `deserializeSurface(json)` | `Result<CanvasSurface, KoiError>` | JSON → Map |

### Type Guards

| Function | Returns | Purpose |
|----------|---------|---------|
| `isA2uiComponentType(value)` | `boolean` | Check 18 types |
| `isA2uiMessageKind(value)` | `boolean` | Check 4 message kinds |
| `isCanvasEvent(event)` | `boolean` | Check `a2ui:` prefix |
| `categorizeComponent(type)` | `A2uiCategory` | layout/display/input |

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────┐
    JsonObject, EngineEvent, ContentBlock,               │
    KoiError, Result<T,E> — types only                   │
                                                         │
L0u @koi/validation ─────────────────────────┐          │
    validateWith() wrapper                   │          │
                                             ▼          ▼
L2  @koi/canvas ◄────────────────────────────┴──────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✓ zod is the sole external dependency
```

**Dev-only:** `@koi/test-utils` used in tests but not a runtime import.
