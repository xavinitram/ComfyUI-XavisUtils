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
