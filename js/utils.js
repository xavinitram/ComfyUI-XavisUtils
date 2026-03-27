/**
 * utils.js
 * Shared helpers for all Xavi's Utils features.
 */

import { app } from "../../scripts/app.js";

// Graph area selectors (works with LiteGraph + partial Nodes 2.0 compat)
export const GRAPH_SELECTOR =
  "#graph-canvas, .graph-canvas-container, .litegraph, .comfy-vue-node-area";

const SLOT_HIT_RADIUS = 14;
const SLOT_HIT_RADIUS_SQ = SLOT_HIT_RADIUS * SLOT_HIT_RADIUS;

// ---------------------------------------------------------------------------
// Graph access — always use this instead of app.graph directly
// ---------------------------------------------------------------------------

/**
 * Get the currently-viewed graph (handles subgraphs).
 * When inside a subgraph, app.canvas.graph points to the subgraph
 * while app.graph still points to the root graph.
 */
export function getCurrentGraph() {
  return app.canvas?.graph || app.graph;
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

/** Check if an event originated inside the graph canvas area. */
export function inGraph(ev) {
  return ev.target instanceof Element && !!ev.target.closest(GRAPH_SELECTOR);
}

/**
 * Convert pointer event to LiteGraph graph-space coordinates.
 * Falls back through several methods for compatibility.
 * @returns {[number, number] | null}
 */
export function eventToGraphPos(ev) {
  const canvas = app.canvas;
  if (!canvas) return null;

  // Method 1: LiteGraph convertEventToCanvasOffset (if available)
  if (canvas.convertEventToCanvasOffset) {
    try {
      const pos = canvas.convertEventToCanvasOffset(ev);
      if (pos) return pos;
    } catch (_) { /* fall through */ }
  }

  // Method 2: Manual computation from draw state
  const ds = canvas.ds;
  const canvasEl = app.canvasEl || document.getElementById("graph-canvas");
  if (ds && canvasEl) {
    const rect = canvasEl.getBoundingClientRect();
    const x = (ev.clientX - rect.left) / ds.scale - ds.offset[0];
    const y = (ev.clientY - rect.top) / ds.scale - ds.offset[1];
    return [x, y];
  }

  return null;
}

/**
 * Convert graph-space position to screen-space (viewport) coordinates.
 * @returns {[number, number] | null}
 */
export function graphPosToScreen(gx, gy) {
  const ds = app.canvas?.ds;
  const canvasEl = app.canvasEl || document.getElementById("graph-canvas");
  if (!ds || !canvasEl) return null;
  const rect = canvasEl.getBoundingClientRect();
  return [
    (gx + ds.offset[0]) * ds.scale + rect.left,
    (gy + ds.offset[1]) * ds.scale + rect.top,
  ];
}

// ---------------------------------------------------------------------------
// Slot hit-testing
// ---------------------------------------------------------------------------

/**
 * Find the node and slot under the cursor.
 * @param {PointerEvent} ev
 * @param {"input"|"output"} slotType
 * @returns {{ node, slotIndex, slot } | null}
 */
export function findSlotUnderCursor(ev, slotType) {
  const graph = getCurrentGraph();
  if (!graph) return null;

  const graphPos = eventToGraphPos(ev);
  if (!graphPos) return null;
  const [gx, gy] = graphPos;

  const node = graph.getNodeOnPos(gx, gy, graph._nodes);
  if (!node || node.flags?.collapsed) return null;

  const slots = slotType === "input" ? node.inputs : node.outputs;
  if (!slots) return null;

  for (let i = 0; i < slots.length; i++) {
    const isInput = slotType === "input";
    const pos = node.getConnectionPos(isInput, i);
    if (!pos) continue;

    const dx = gx - pos[0];
    const dy = gy - pos[1];
    if (dx * dx + dy * dy < SLOT_HIT_RADIUS_SQ) {
      return { node, slotIndex: i, slot: slots[i] };
    }
  }

  return null;
}

/**
 * Find any node under the cursor (body hit, not just slots).
 * @param {PointerEvent} ev
 * @returns {object|null} the LiteGraph node
 */
export function findNodeUnderCursor(ev) {
  const graph = getCurrentGraph();
  if (!graph) return null;
  const graphPos = eventToGraphPos(ev);
  if (!graphPos) return null;
  return graph.getNodeOnPos(graphPos[0], graphPos[1], graph._nodes) || null;
}

// ---------------------------------------------------------------------------
// Link resolution — handles Array, Map, and Object storage formats
// ---------------------------------------------------------------------------

/**
 * Resolve a single link by ID, handling all LiteGraph storage formats.
 * @param {object} graph
 * @param {number|string} linkId
 * @returns {object|null}
 */
export function resolveLink(graph, linkId) {
  if (linkId == null) return null;
  if (graph._links instanceof Map) return graph._links.get(linkId) || null;
  if (graph.links instanceof Map) return graph.links.get(linkId) || null;
  return graph.links?.[linkId] || null;
}

/**
 * Collect all link objects from the graph.
 * Handles Array (sparse), Map, and Object storage.
 */
export function collectAllLinks(graph) {
  const all = [];
  if (!graph.links) return all;

  if (graph.links instanceof Map || graph._links instanceof Map) {
    const map = graph._links || graph.links;
    map.forEach((link) => { if (link) all.push(link); });
  } else if (Array.isArray(graph.links)) {
    for (const link of graph.links) {
      if (link) all.push(link);
    }
  } else {
    for (const key of Object.keys(graph.links)) {
      const link = graph.links[key];
      if (link) all.push(link);
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// Bezier math — matches LiteGraph's wire rendering
// ---------------------------------------------------------------------------

/** Evaluate cubic bezier at parameter t. */
export function evalCubic(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const uu = u * u;
  const uuu = uu * u;
  const tt = t * t;
  const ttt = tt * t;
  return [
    uuu * p0[0] + 3 * uu * t * p1[0] + 3 * u * tt * p2[0] + ttt * p3[0],
    uuu * p0[1] + 3 * uu * t * p1[1] + 3 * u * tt * p2[1] + ttt * p3[1],
  ];
}

/** Compute LiteGraph-style cubic bezier control points for a wire. */
export function bezierControlPoints(srcPos, dstPos) {
  const dx = Math.abs(dstPos[0] - srcPos[0]);
  const offsetX = Math.max(dx * 0.5, 40);
  return {
    cp0: srcPos,
    cp1: [srcPos[0] + offsetX, srcPos[1]],
    cp2: [dstPos[0] - offsetX, dstPos[1]],
    cp3: dstPos,
  };
}

// ---------------------------------------------------------------------------
// Wire color lookup
// ---------------------------------------------------------------------------

const TYPE_COLORS = {
  IMAGE: "#64b5f6",  MASK: "#ffffff",  LATENT: "#ff9cf9",
  MODEL: "#b39ddb",  CLIP: "#fdd835",  VAE: "#ff6e6e",
  CONDITIONING: "#ffa931",  CONTROL_NET: "#00d78a",
  INT: "#29699c",  FLOAT: "#a1d5a1",  STRING: "#8ae68a",  "*": "#aaaaaa",
};

/** Get the display colour for a wire type, checking LiteGraph registry first. */
export function getWireColor(type) {
  if (!type) return TYPE_COLORS["*"];
  try {
    const c = LiteGraph?.registered_slot_out_types?.[type]?.color;
    if (c) return c;
  } catch (_) {}
  return TYPE_COLORS[type] || TYPE_COLORS["*"];
}

// ---------------------------------------------------------------------------
// Visual feedback
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Wire SVG path — respects LiteGraph rendering mode
// ---------------------------------------------------------------------------

/**
 * Build an SVG path string for a wire between two screen-space points.
 * Checks `app.canvas.links_render_mode` to match the current wire style:
 *   0 = STRAIGHT_LINK, 1 = LINEAR_LINK, 2 = SPLINE_LINK (default).
 *
 * @param {number} sx0 - source X (screen)
 * @param {number} sy0 - source Y (screen)
 * @param {number} sx1 - destination X (screen)
 * @param {number} sy1 - destination Y (screen)
 * @param {boolean} [reverseControlPoints=false] - if true, control points curve
 *   leftward from source (used when drawing from an input slot toward cursor)
 */
export function buildWireSVGPath(sx0, sy0, sx1, sy1, reverseControlPoints = false) {
  const mode = app.canvas?.links_render_mode;

  if (mode === 0) {
    // STRAIGHT_LINK
    return `M ${sx0} ${sy0} L ${sx1} ${sy1}`;
  }

  if (mode === 1) {
    // LINEAR_LINK: orthogonal horizontal-vertical-horizontal
    const mx = (sx0 + sx1) / 2;
    return `M ${sx0} ${sy0} L ${mx} ${sy0} L ${mx} ${sy1} L ${sx1} ${sy1}`;
  }

  // SPLINE_LINK (default): cubic bezier
  const dx = Math.abs(sx1 - sx0);
  const offsetX = Math.max(dx * 0.5, 30);

  if (reverseControlPoints) {
    // Input-side: curve leftward from source, rightward to destination
    return (
      `M ${sx0} ${sy0} ` +
      `C ${sx0 - offsetX} ${sy0}, ` +
      `${sx1 + offsetX} ${sy1}, ` +
      `${sx1} ${sy1}`
    );
  }

  return (
    `M ${sx0} ${sy0} ` +
    `C ${sx0 + offsetX} ${sy0}, ` +
    `${sx1 - offsetX} ${sy1}, ` +
    `${sx1} ${sy1}`
  );
}

/** Green flash animation over a node (used on insertion). */
export function showInsertFlash(node) {
  const pos = node.pos;
  const size = node.size;
  if (!pos || !size) return;

  const topLeft = graphPosToScreen(pos[0], pos[1]);
  const bottomRight = graphPosToScreen(pos[0] + size[0], pos[1] + size[1]);
  if (!topLeft || !bottomRight) return;

  const flash = document.createElement("div");
  flash.className = "xavis-drop-insert-flash";
  flash.style.left = `${topLeft[0]}px`;
  flash.style.top = `${topLeft[1]}px`;
  flash.style.width = `${bottomRight[0] - topLeft[0]}px`;
  flash.style.height = `${bottomRight[1] - topLeft[1]}px`;

  document.body.appendChild(flash);
  flash.addEventListener("animationend", () => flash.remove());
}
