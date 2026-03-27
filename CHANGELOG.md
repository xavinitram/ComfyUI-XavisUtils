# Changelog

All notable changes to Xavi's Utils are documented in this file.

## [0.4.0] - 2026-03-27

### Added
- **Tab Search**: Press Tab to open the node search dialog at the current cursor position. If a wire is being dragged, the search filters to compatible node types. Inspired by Houdini, Nuke, and Blender.
- **Dot on Wire**: Double-click an existing wire to insert a Reroute (dot) node at that position. The original connection is split through the reroute. Double-clicks that miss a wire pass through to ComfyUI normally.
- **Dataflow Highlight**: Hover over a node to highlight its full upstream (blue) and downstream (orange) dependency chain. Configurable hover delay. Follows canvas pan/zoom in real time.
- **RMB Zoom**: Right-click and drag on empty canvas to zoom in/out (up = zoom in, down = zoom out). Stationary right-clicks still open the context menu. Configurable sensitivity. Inspired by Houdini's viewport navigation.

### Changed
- Extracted shared utilities to `utils.js`: `resolveLink`, `collectAllLinks`, `evalCubic`, `bezierControlPoints`, `getWireColor`, `showInsertFlash`, `buildWireSVGPath`. Reduces duplication across feature modules.
- Wire rendering (`buildWireSVGPath`) now respects `app.canvas.links_render_mode` — highlights match straight, linear, and spline wire styles.
- Dataflow highlight uses a `requestAnimationFrame` render loop with dirty-checking and `getBoundingClientRect()` caching for minimal overhead.

### Fixed
- Wire highlights no longer use spline curves when ComfyUI wire style is set to linear or straight.
- Removed stray `console.log` debug messages from inspector and shake-disconnect modules.

## [0.3.0] - 2026-03-10

### Added
- **Drop Node on Wire**: Drag a node onto an existing wire to insert it into the connection. Requires both a compatible input and output on the node. Visual feedback with wire highlight, slot indicators, and green flash on insertion.
- Shared gesture CSS for drop-on-wire highlight and insertion flash animations.

### Fixed
- All features now use `getCurrentGraph()` instead of `app.graph`, fixing broken behaviour inside subgraphs.
- Schema lookups now prefer `node.comfyClass` over `node.type` for correct resolution.
- Cleaned up stale naming from earlier development.

## [0.2.0] - 2026-03-06

### Added
- **Node Inspector**: Hold middle mouse button over a node to view detailed info (inputs, outputs, types, execution stats, thumbnails). Ctrl+MMB pins a persistent panel. Configurable activation binding (MMB, Alt+MMB, Ctrl+Click), hold delay, and drift threshold.
- **Shake to Disconnect**: Rapidly shake a node side-to-side while dragging to disconnect it. Upstream and downstream nodes are automatically re-wired where types match. Configurable reversal count and time window.
- **Wire Knife**: Hold Y and drag to draw a knife line that cuts any wires it crosses. Bezier intersection detection with 20-point curve sampling.
- **Input Rewire**: Click and drag from a connected input slot to reassign its source. Drop on an output to replace the connection; drop on empty space to keep the original.
- Backend telemetry system: per-node execution timing, VRAM/RAM deltas, output profiling with tensor metadata and thumbnails.
- REST API endpoint (`/mmb_inspector/outputs/{node_id}`) for output inspection.
- Shared utility library (`utils.js`) with graph access, coordinate conversion, and hit-testing helpers.
- Settings panel integration under "Xavi's Utils" category with per-feature toggles and configuration.
