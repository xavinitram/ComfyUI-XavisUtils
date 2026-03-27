# Architecture

How Xavi's Utils works under the hood.

## Overview

Xavi's Utils is a frontend-heavy ComfyUI extension. The backend (`__init__.py`) handles execution telemetry and output profiling. The frontend (`js/`) handles all UI features as independent modules that share a small utility library.

```
ComfyUI_XavisUtils/
├── __init__.py              # Backend: telemetry handler + REST API
├── pyproject.toml           # ComfyUI packaging metadata
├── js/
│   ├── utils.js             # Shared helpers (graph access, hit-testing, coordinate conversion,
│   │                         #   link resolution, bezier math, wire colors, SVG path building)
│   ├── inspector.js         # Node Inspector: gesture state machine + extension registration
│   ├── inspector-cache.js   # Inspector: frontend caching layer (object_info, telemetry, output profiles)
│   ├── inspector-panel.js   # Inspector: DOM rendering (panel content, positioning)
│   ├── inspector-styles.css # Inspector: all CSS
│   ├── shake-disconnect.js  # Shake to Disconnect: gesture detection + re-wire logic
│   ├── wire-knife.js        # Wire Knife: Y+drag cutting with bezier intersection
│   ├── input-rewire.js      # Input Rewire: drag from input to output
│   ├── drop-on-wire.js      # Drop on Wire: insert node into existing connection
│   ├── rmb-zoom.js          # RMB Zoom: right-click drag to zoom in/out
│   ├── tab-search.js        # Tab Search: open search dialog at cursor position
│   ├── dot-on-wire.js       # Dot on Wire: double-click wire to insert Reroute
│   ├── dataflow-highlight.js # Dataflow Highlight: upstream/downstream dependency chains
│   └── gesture-styles.css   # Shared CSS for gesture features (SVG overlays, animations)
```

## Backend (`__init__.py`)

### Telemetry

A custom `ProgressHandler` hooks into ComfyUI's execution pipeline:

1. **`start_handler(node_id)`** — Records start time, current VRAM, and RAM.
2. **`finish_handler(node_id)`** — Computes deltas, resolves `display_node_id` (for subgraph/group nodes), stores in a persistent `_TelemetryStore`, and pushes a `mmb_inspector.telemetry` WebSocket event.

The `_TelemetryStore` persists cook times across cache re-runs. When a node is cache-hit, the handler preserves the last recorded cook time rather than overwriting with 0.

### Output Profiling REST API

`GET /mmb_inspector/outputs/{node_id}?thumbs=1`

Profiles cached outputs for a given node. Returns:
- Tensor metadata (shape, dtype, device, kind: IMAGE/MASK/LATENT/AUDIO)
- Resolution info (width, height, batch, approximate pixel dimensions for latents)
- Cache memory estimate
- Base64 JPEG thumbnails (128px max dimension) for IMAGE and MASK tensors

The endpoint accesses `PromptExecutor.caches` via a monkey-patched `__init__` on `PromptExecutor` that stores a reference on the server instance.

### Important: No GPU data transfer

Output profiling **never** transfers tensor data from GPU to CPU for full inspection. It reads only metadata (`shape`, `dtype`, `device`) and lightweight properties. Thumbnails are the only exception — they call `.cpu()` on a single batch element clamped to a 128px thumbnail.

## Frontend

### Module Loading

ComfyUI auto-discovers `.js` files in the `js/` directory. Each feature file calls `app.registerExtension()` to register itself. Extensions are loaded independently — disabling one feature does not affect others.

### Shared Utilities (`utils.js`)

All features import from `utils.js` rather than accessing LiteGraph internals directly:

- **`getCurrentGraph()`** — Returns `app.canvas.graph` (current subgraph) falling back to `app.graph` (root). This is critical for subgraph support.
- **`inGraph(ev)`** — Tests if a pointer event originated inside the graph canvas area.
- **`eventToGraphPos(ev)`** — Converts screen coordinates to LiteGraph graph-space coordinates. Falls back through `canvas.convertEventToCanvasOffset()` and manual computation.
- **`graphPosToScreen(gx, gy)`** — Inverse of the above.
- **`findSlotUnderCursor(ev, "input"|"output")`** — Hit-tests input or output slots within a 14px radius.
- **`findNodeUnderCursor(ev)`** — Hit-tests node bodies.
- **`resolveLink(graph, linkId)`** — Resolves a link ID to a link object, handling all LiteGraph storage formats (Array, Map, Object).
- **`collectAllLinks(graph)`** — Collects all link objects from the graph, handling sparse arrays, Maps, and Objects.
- **`evalCubic(p0, p1, p2, p3, t)`** — Evaluates a cubic bezier at parameter t.
- **`bezierControlPoints(srcPos, dstPos)`** — Computes LiteGraph-style horizontal control points for a wire bezier.
- **`getWireColor(type)`** — Returns the display colour for a wire type, checking `LiteGraph.registered_slot_out_types` first, then a built-in palette.
- **`buildWireSVGPath(sx0, sy0, sx1, sy1, reverse?)`** — Builds an SVG path string matching the current wire rendering mode (straight, linear, or spline).
- **`showInsertFlash(node)`** — Shows a green flash animation over a node (used by drop-on-wire and dot-on-wire).

### Node Inspector

**Gesture state machine** (`inspector.js`):

```
IDLE → CANDIDATE (binding pressed) → INSPECTING (hold timer fires)
                                    → PANNING (drift threshold exceeded)
```

The inspector never calls `preventDefault()` on `pointerdown` — this allows LiteGraph's canvas panning to work normally. It only intercepts the gesture after the hold timer fires.

**Caching layer** (`inspector-cache.js`):

- `/object_info` is fetched once at startup and cached for the entire session (node type definitions).
- Telemetry arrives via WebSocket and is cached per-prompt (cleared on `execution_start`).
- Output profiles are fetched on-demand via REST and cached per-prompt.
- Execution counts and errors are session-scoped (never cleared).

**Panel rendering** (`inspector-panel.js`):

Pure DOM rendering with zero framework dependencies. Creates elements via a lightweight `el()` helper. The panel is positioned via `translate3d` for GPU-composited movement.

Wire colours are resolved from `app.canvas.default_connection_color_byType` to match LiteGraph's wire palette.

### Shake to Disconnect

**Non-invasive monitoring**: The shake detector attaches `pointerdown`/`pointermove`/`pointerup` listeners in capture phase but **never calls `stopPropagation()` or `preventDefault()`**. It passively monitors LiteGraph's normal node drag.

**Detection algorithm**: Tracks horizontal direction reversals (left → right → left). When N reversals occur within a configurable time window, the shake is triggered.

**Re-wire logic** (executed before disconnect):
1. Collect all input connections (upstream nodes + slots)
2. Collect all output connections (downstream nodes + slots)
3. Group by type
4. Pair inputs to outputs 1:1 by index within each type group
5. Create bypass connections via `node.connect()`
6. Disconnect all connections from the shaken node

Step 5 happens **before** step 6 because the link metadata is needed to create bypass connections.

### Wire Knife

**State machine**: `IDLE → ARMED (Y held) → CUTTING (Y + drag) → IDLE`

When armed, the knife intercepts pointer events (`stopPropagation()`) to prevent LiteGraph from handling them. A dashed SVG line is drawn in screen-space as visual feedback.

**Bezier intersection**: LiteGraph draws wires as cubic beziers with horizontal control points. The knife line is tested against each wire by:
1. Computing bezier control points (same formula as LiteGraph's renderer)
2. Sampling 20 points along the curve
3. Testing each consecutive pair against the knife line using 2D cross-product segment intersection

### Input Rewire

The most complex feature because LiteGraph has **no native "connecting from input"** support. There is no `connecting_input` state variable — clicking a connected input in stock LiteGraph just calls `disconnectInput()`.

The rewire handler:
1. Intercepts `pointerdown` on connected input slots (capture phase, `stopPropagation()`)
2. Draws a live bezier wire preview (SVG path) from the input slot to the cursor
3. Highlights output slots when the cursor hovers near them
4. On drop: calls `node.connect(outputSlot, targetNode, inputSlot)` — LiteGraph auto-replaces the old input connection
5. On drop on empty space: does nothing (old connection preserved)

### Drop on Wire

Passively monitors node drags (same pattern as shake-disconnect — capture phase, no event interception). On each `pointermove` (throttled to 60ms):

1. Checks if the node has moved 20px+ from its start position
2. Computes the node's bounding box (with 10px padding for tolerance)
3. Iterates all links in `getCurrentGraph()`, applying an AABB pre-filter to skip distant wires
4. For surviving candidates: checks type compatibility (`findBestSlotPair` — the node must have both a matching input AND output), then samples 20 points along the bezier curve and tests if any fall inside the node box
5. If multiple wires match, picks the closest to the node's center

On drop: disconnects the original wire, connects source→node input, connects node output→target. A green flash confirms the insertion.

### RMB Zoom

**State machine**: `IDLE → CANDIDATE (RMB down on empty canvas) → DRAGGING (vertical threshold exceeded)`

Uses a **deferred interception** strategy: `pointerdown` is NOT intercepted (no `stopPropagation()`) so that stationary right-clicks still open the LiteGraph context menu. The gesture only takes over once the mouse moves beyond a 5px vertical dead zone.

**Empty canvas detection**: On `pointerdown`, checks `graph.getNodeOnPos()` and `graph.getGroupOnPos()` to ensure the click is on empty space. If a node or group is under the cursor, the gesture is not started and LiteGraph handles the event normally.

**Zoom math**: `newScale = startScale * Math.exp(deltaY * sensitivity)` where `deltaY = startY - clientY` (moving up = zoom in). The exponential mapping produces perceptually uniform zoom. The zoom is anchored to the initial click position via `app.canvas.setZoom(scale, center)`.

**Context menu suppression**: A `contextmenu` listener in capture phase suppresses the browser/LiteGraph context menu only after a drag occurred. A time-limited flag (`suppressContextMenu`) is set on `pointerup` and cleared after 100ms.

### Tab Search

Intercepts the **Tab** keydown event in capture phase. Before triggering, checks that:
1. The cursor is inside the graph canvas (`inGraph` via `document.elementFromPoint`)
2. No modal dialogs, search boxes, or text inputs are focused
3. No text is selected

Calls `app.canvas.showSearchBox(ev)` to open ComfyUI's built-in search. If the user is currently dragging a wire (`canvas.connecting_output` or `canvas.connecting_input`), the search automatically filters to compatible types.

Mouse position is tracked passively via a `mousemove` listener (stores `lastMouseX`, `lastMouseY`). The graph-canvas check uses `document.elementFromPoint()` at Tab-press time to avoid stale DOM references.

### Dot on Wire

Listens for `dblclick` events. On double-click:

1. Converts cursor position to graph coordinates via `eventToGraphPos()`
2. Iterates all links via `collectAllLinks()`, applying an **AABB pre-filter** (4 cheap comparisons per wire) before expensive bezier sampling
3. For surviving candidates, samples 24 points along each wire's bezier curve and computes minimum squared distance to the click point
4. If the closest wire is within 400px² (20px), creates a Reroute node at the click position
5. Splits the original connection through the reroute: source → reroute input, reroute output → original target

Falls back through two Reroute node type names: `"Reroute"` then `"RerouteNode"`.

### Dataflow Highlight

Hover over a node to highlight its full upstream and downstream dependency chain.

**Graph traversal**: `collectUpstreamLinks` and `collectDownstreamLinks` recursively walk input/output connections using `resolveLink()` for consistent link resolution across all storage formats. Visited sets prevent infinite loops in cyclic graphs.

**Render loop**: A `requestAnimationFrame` loop runs while a node is highlighted. Optimisations:
- **Dirty-checking**: Compares `canvas.ds.scale`, `ds.offset[0]`, `ds.offset[1]` against cached values — skips rendering when the canvas transform hasn't changed
- **Rect caching**: `getBoundingClientRect()` is called once per frame and passed through, avoiding 2N layout thrashes
- **SVG path pool**: A growable pool of `{ el, lastD, lastCls }` entries caches path strings and class names, only calling `setAttribute` when values change

**Hover detection**: A `pointermove` listener in capture phase uses `graph.getNodeOnPos()` to detect which node is under the cursor. A configurable delay timer (default 200ms) prevents flicker during fast mouse movement. Any `pointerdown` immediately deactivates the highlight to avoid interference with interactions.

**Styling**: Upstream wires use class `xavis-flow-upstream` (blue), downstream use `xavis-flow-downstream` (orange). Both are semi-transparent with a subtle glow filter.

## Settings

All features register settings via `app.registerExtension({ settings: [...] })`. Settings use the `"xavis."` prefix and are organized under the `["Xavi's Utils", "Feature Name"]` category hierarchy.

Settings are read both at startup (initial values) and via `onChange` callbacks (live updates). The pattern:

```js
// In module scope
let enabled = true;

// In settings array
{
  id: "xavis.feature.Enabled",
  type: "boolean",
  defaultValue: true,
  onChange: (v) => { enabled = !!v; },
}

// In setup()
const en = getSetting.call(ctx, "xavis.feature.Enabled");
if (en != null) enabled = !!en;
```

## Subgraph Support

All graph access goes through `getCurrentGraph()` from `utils.js`, which returns `app.canvas.graph` (the currently-viewed graph, including subgraphs) falling back to `app.graph` (root). This is essential because LiteGraph changes `canvas.graph` when entering a subgraph, but `app.graph` always points to the root.

Note: The backend telemetry uses `dynprompt.get_display_node_id()` to resolve expanded/group node IDs back to the display-level node ID that the user sees.
