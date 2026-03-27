/**
 * rmb-zoom.js
 * Xavi's Utils — Right-Click Drag Zoom
 *
 * Right-click and drag on empty canvas to zoom in/out.
 * Drag up to zoom in, drag down to zoom out.
 * Stationary right-clicks still open the context menu.
 * Inspired by Houdini's viewport navigation.
 */

import { app } from "../../scripts/app.js";
import { inGraph, eventToGraphPos, getCurrentGraph } from "./utils.js";

// ---------------------------------------------------------------------------
// Settings state
// ---------------------------------------------------------------------------
let enabled = true;
let sensitivity = 0.005;

// ---------------------------------------------------------------------------
// State machine: IDLE -> CANDIDATE (RMB down) -> DRAGGING (threshold met)
// ---------------------------------------------------------------------------
const IDLE = 0;
const CANDIDATE = 1;
const DRAGGING = 2;

let state = IDLE;
let startY = 0;
let startScale = 1;
let zoomCenter = null;   // [x, y] screen coords — zoom focal point
let activePointerId = -1;
let suppressContextMenu = false;
let savedCursor = "";

const DRAG_THRESHOLD = 5; // pixels of vertical movement before zoom activates

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetState() {
  if (state === DRAGGING) {
    document.body.style.cursor = savedCursor;
  }
  state = IDLE;
  startY = 0;
  startScale = 1;
  zoomCenter = null;
  activePointerId = -1;
}

// ---------------------------------------------------------------------------
// Empty canvas detection
// ---------------------------------------------------------------------------

/**
 * Check if the pointer is over empty canvas (no node, no group).
 * Returns true if empty, false if something is under the cursor.
 */
function isEmptyCanvas(ev) {
  const graphPos = eventToGraphPos(ev);
  if (!graphPos) return false;

  const graph = getCurrentGraph();
  if (!graph) return false;

  const [gx, gy] = graphPos;

  // Check for nodes
  if (graph.getNodeOnPos(gx, gy, graph._nodes)) return false;

  // Check for groups
  if (graph.getGroupOnPos?.(gx, gy)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Pointer listeners
// ---------------------------------------------------------------------------

function onPointerDown(ev) {
  if (!enabled) return;
  if (ev.button !== 2) return;
  if (!inGraph(ev)) return;
  if (state !== IDLE) return;

  // Only activate on empty canvas
  if (!isEmptyCanvas(ev)) return;

  // Enter candidate state — do NOT stopPropagation so LiteGraph
  // can still process this as a potential context menu trigger.
  state = CANDIDATE;
  startY = ev.clientY;
  startScale = app.canvas?.ds?.scale || 1;
  zoomCenter = [ev.clientX, ev.clientY];
  activePointerId = ev.pointerId;
}

function onPointerMove(ev) {
  if (state === IDLE) return;
  if (ev.pointerId !== activePointerId) return;
  if (!enabled) { resetState(); return; }

  if (state === CANDIDATE) {
    // Check if drag threshold exceeded
    if (Math.abs(ev.clientY - startY) <= DRAG_THRESHOLD) return;

    // Transition to dragging
    state = DRAGGING;
    savedCursor = document.body.style.cursor;
    document.body.style.cursor = "ns-resize";
    suppressContextMenu = true;
  }

  if (state === DRAGGING) {
    const deltaY = startY - ev.clientY; // up = positive = zoom in
    const zoomFactor = Math.exp(deltaY * sensitivity);
    const newScale = startScale * zoomFactor;

    // Clamp to LiteGraph limits or sensible defaults
    const ds = app.canvas?.ds;
    const minScale = ds?.min_scale ?? 0.1;
    const maxScale = ds?.max_scale ?? 10;
    const clamped = Math.max(minScale, Math.min(maxScale, newScale));

    app.canvas.setZoom(clamped, zoomCenter);

    ev.stopPropagation();
    ev.preventDefault();
  }
}

function onPointerUp(ev) {
  if (state === IDLE) return;
  if (ev.pointerId !== activePointerId) return;

  const wasDragging = state === DRAGGING;
  resetState();

  if (wasDragging) {
    // Suppress the context menu that fires after pointerup
    suppressContextMenu = true;
    setTimeout(() => { suppressContextMenu = false; }, 100);

    ev.stopPropagation();
    ev.preventDefault();
  }
  // If was CANDIDATE (no drag), do nothing — LiteGraph handles normally
}

function onContextMenu(ev) {
  if (suppressContextMenu) {
    ev.stopPropagation();
    ev.preventDefault();
    suppressContextMenu = false;
  }
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "xavis.rmb_zoom",

  settings: [
    {
      id: "xavis.rmbZoom.Enabled",
      name: "Enable RMB Drag Zoom",
      type: "boolean",
      defaultValue: true,
      tooltip:
        "Right-click and drag on empty canvas to zoom. " +
        "Drag up to zoom in, down to zoom out. Inspired by Houdini.",
      category: ["Xavi's Utils", "RMB Zoom"],
      onChange: (v) => { enabled = !!v; },
    },
    {
      id: "xavis.rmbZoom.Sensitivity",
      name: "Zoom sensitivity",
      type: "number",
      defaultValue: 5,
      tooltip:
        "How fast the zoom responds to mouse movement. " +
        "Higher values = faster zoom. Range: 1 (slow) to 20 (fast).",
      category: ["Xavi's Utils", "RMB Zoom"],
      attrs: { min: 1, max: 20, step: 1 },
      onChange: (v) => { sensitivity = (Number(v) || 5) * 0.001; },
    },
  ],

  async setup() {
    // Read initial settings
    try {
      const getSetting = app.extensionManager?.setting?.get
        ?? app.ui?.settings?.getSettingValue;
      if (getSetting) {
        const ctx = app.extensionManager?.setting ?? app.ui?.settings;

        const en = getSetting.call(ctx, "xavis.rmbZoom.Enabled");
        if (en != null) enabled = !!en;

        const s = getSetting.call(ctx, "xavis.rmbZoom.Sensitivity");
        if (s != null) sensitivity = (Number(s) || 5) * 0.001;
      }
    } catch (_) { /* use defaults */ }

    // Capture phase — deferred interception strategy:
    // pointerdown: no stopPropagation (preserve context menu on click)
    // pointermove/pointerup: stopPropagation only when DRAGGING
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", () => {
      suppressContextMenu = false;
      if (state !== IDLE) resetState();
    }, true);

    // Context menu suppression — must be capture phase to beat LiteGraph
    document.addEventListener("contextmenu", onContextMenu, true);
  },
});
