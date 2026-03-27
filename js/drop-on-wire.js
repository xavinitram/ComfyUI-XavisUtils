/**
 * drop-on-wire.js
 * Xavi's Utils — Drop Node on Wire
 *
 * Drag a node onto an existing wire to insert it into the connection.
 * The node must have both a compatible input AND output for the wire's type.
 * Inspired by Houdini and Nuke's node insertion UX.
 */

import { app } from "../../scripts/app.js";
import {
  inGraph,
  findNodeUnderCursor,
  getCurrentGraph,
  graphPosToScreen,
  collectAllLinks,
  evalCubic,
  bezierControlPoints,
  getWireColor,
  showInsertFlash,
  buildWireSVGPath,
} from "./utils.js";

// ---------------------------------------------------------------------------
// Settings state
// ---------------------------------------------------------------------------
let enabled = true;

// ---------------------------------------------------------------------------
// Drag monitoring state
// ---------------------------------------------------------------------------
let watching = false;
let watchedNode = null;
let dragStartPos = null; // [x, y] node position at drag start
let lastCheckTime = 0;
let highlightedLink = null;
let matchedSlots = null; // { inputSlot, outputSlot }

const THROTTLE_MS = 60;
const MIN_DRAG_DIST_SQ = 20 * 20; // 20px minimum drag distance
const BEZIER_SAMPLES = 20;

// ---------------------------------------------------------------------------
// SVG overlay elements
// ---------------------------------------------------------------------------
let svgOverlay = null;
let wireHighlight = null; // <path> for highlighted wire
let inputDot = null;      // <circle> for matched input slot
let outputDot = null;     // <circle> for matched output slot

// ---------------------------------------------------------------------------
// SVG overlay management
// ---------------------------------------------------------------------------

function ensureOverlay() {
  if (svgOverlay) return;

  // Reuse shared gesture overlay if it exists
  svgOverlay = document.querySelector(".xavis-gesture-overlay");
  if (!svgOverlay) {
    svgOverlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svgOverlay.classList.add("xavis-gesture-overlay");
    document.body.appendChild(svgOverlay);
  }

  wireHighlight = document.createElementNS("http://www.w3.org/2000/svg", "path");
  wireHighlight.classList.add("xavis-drop-wire-highlight");
  wireHighlight.style.display = "none";
  svgOverlay.appendChild(wireHighlight);

  inputDot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  inputDot.classList.add("xavis-drop-slot-indicator");
  inputDot.setAttribute("r", "6");
  inputDot.style.display = "none";
  svgOverlay.appendChild(inputDot);

  outputDot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  outputDot.classList.add("xavis-drop-slot-indicator");
  outputDot.setAttribute("r", "6");
  outputDot.style.display = "none";
  svgOverlay.appendChild(outputDot);
}

// ---------------------------------------------------------------------------
// Type matching
// ---------------------------------------------------------------------------

function typesMatch(slotType, wireType) {
  if (!slotType || slotType === "*") return true;
  if (!wireType || wireType === "*") return true;
  return slotType === wireType;
}

/**
 * Find the best input/output slot pair on a node that matches the wire type.
 * Returns { inputSlot, outputSlot } or null if no valid pair exists.
 */
function findBestSlotPair(node, wireType) {
  let bestInput = -1;
  if (node.inputs) {
    for (let i = 0; i < node.inputs.length; i++) {
      if (typesMatch(node.inputs[i].type, wireType)) {
        bestInput = i;
        break;
      }
    }
  }

  let bestOutput = -1;
  if (node.outputs) {
    for (let i = 0; i < node.outputs.length; i++) {
      if (typesMatch(node.outputs[i].type, wireType)) {
        bestOutput = i;
        break;
      }
    }
  }

  if (bestInput === -1 || bestOutput === -1) return null;
  return { inputSlot: bestInput, outputSlot: bestOutput };
}

// ---------------------------------------------------------------------------
// Bezier helpers (use shared evalCubic / bezierControlPoints from utils.js)
// ---------------------------------------------------------------------------

/** Loose AABB for a bezier wire (includes control point extent). */
function bezierAABB(srcPos, dstPos) {
  const dx = Math.abs(dstPos[0] - srcPos[0]);
  const offsetX = Math.max(dx * 0.5, 40);
  return {
    x1: Math.min(srcPos[0], dstPos[0] - offsetX),
    y1: Math.min(srcPos[1], dstPos[1]),
    x2: Math.max(srcPos[0] + offsetX, dstPos[0]),
    y2: Math.max(srcPos[1], dstPos[1]),
  };
}

function boxesOverlap(a, b) {
  return a.x1 <= b.x2 && a.x2 >= b.x1 && a.y1 <= b.y2 && a.y2 >= b.y1;
}

/** Test if any sampled bezier point falls inside the node box. */
function bezierIntersectsBox(srcPos, dstPos, box) {
  const { cp0, cp1, cp2, cp3 } = bezierControlPoints(srcPos, dstPos);
  for (let i = 0; i <= BEZIER_SAMPLES; i++) {
    const t = i / BEZIER_SAMPLES;
    const pt = evalCubic(cp0, cp1, cp2, cp3, t);
    if (pt[0] >= box.x1 && pt[0] <= box.x2 &&
        pt[1] >= box.y1 && pt[1] <= box.y2) {
      return true;
    }
  }
  return false;
}

/** Minimum squared distance from any bezier sample to a point. */
function bezierDistSqToPoint(srcPos, dstPos, px, py) {
  const { cp0, cp1, cp2, cp3 } = bezierControlPoints(srcPos, dstPos);
  let minDistSq = Infinity;
  for (let i = 0; i <= BEZIER_SAMPLES; i++) {
    const t = i / BEZIER_SAMPLES;
    const pt = evalCubic(cp0, cp1, cp2, cp3, t);
    const dx = pt[0] - px;
    const dy = pt[1] - py;
    const d2 = dx * dx + dy * dy;
    if (d2 < minDistSq) minDistSq = d2;
  }
  return minDistSq;
}

// ---------------------------------------------------------------------------
// Highlight rendering
// ---------------------------------------------------------------------------

function showHighlight(link, slots, graph) {
  const srcNode = graph.getNodeById(link.origin_id);
  const dstNode = graph.getNodeById(link.target_id);
  if (!srcNode || !dstNode) return;

  const srcPos = srcNode.getConnectionPos(false, link.origin_slot);
  const dstPos = dstNode.getConnectionPos(true, link.target_slot);
  if (!srcPos || !dstPos) return;

  const srcScreen = graphPosToScreen(srcPos[0], srcPos[1]);
  const dstScreen = graphPosToScreen(dstPos[0], dstPos[1]);
  if (!srcScreen || !dstScreen) return;

  // Build wire path matching the current LiteGraph rendering mode
  const d = buildWireSVGPath(srcScreen[0], srcScreen[1], dstScreen[0], dstScreen[1]);

  const color = getWireColor(link.type);
  wireHighlight.setAttribute("d", d);
  wireHighlight.setAttribute("stroke", color);
  wireHighlight.style.display = "";

  // Show slot indicators on the dragged node
  const liveNode = graph.getNodeById(watchedNode.id);
  if (liveNode) {
    const inPos = liveNode.getConnectionPos(true, slots.inputSlot);
    if (inPos) {
      const inScreen = graphPosToScreen(inPos[0], inPos[1]);
      if (inScreen) {
        inputDot.setAttribute("cx", inScreen[0]);
        inputDot.setAttribute("cy", inScreen[1]);
        inputDot.setAttribute("stroke", color);
        inputDot.style.display = "";
      }
    }

    const outPos = liveNode.getConnectionPos(false, slots.outputSlot);
    if (outPos) {
      const outScreen = graphPosToScreen(outPos[0], outPos[1]);
      if (outScreen) {
        outputDot.setAttribute("cx", outScreen[0]);
        outputDot.setAttribute("cy", outScreen[1]);
        outputDot.setAttribute("stroke", color);
        outputDot.style.display = "";
      }
    }
  }

  highlightedLink = link;
  matchedSlots = slots;
}

function clearHighlight() {
  if (wireHighlight) wireHighlight.style.display = "none";
  if (inputDot) inputDot.style.display = "none";
  if (outputDot) outputDot.style.display = "none";
  highlightedLink = null;
  matchedSlots = null;
}

// ---------------------------------------------------------------------------
// Connection logic — insert node into wire
// ---------------------------------------------------------------------------

function insertNodeOnWire(node, link, slots, graph) {
  const canvas = app.canvas;
  if (!canvas) return;

  const liveNode = graph.getNodeById(node.id);
  const srcNode = graph.getNodeById(link.origin_id);
  const dstNode = graph.getNodeById(link.target_id);
  if (!liveNode || !srcNode || !dstNode) return;

  // Step 1: Disconnect original wire
  dstNode.disconnectInput(link.target_slot);

  // Step 2: Source → dragged node's input
  srcNode.connect(link.origin_slot, liveNode, slots.inputSlot);

  // Step 3: Dragged node's output → original target
  liveNode.connect(slots.outputSlot, dstNode, link.target_slot);

  // Step 4: Dirty + feedback
  canvas.setDirty(true, true);
  showInsertFlash(liveNode);
}

// ---------------------------------------------------------------------------
// Pointer listeners — passive monitoring (no stopPropagation)
// ---------------------------------------------------------------------------

function onPointerDown(ev) {
  if (!enabled) return;
  if (ev.button !== 0) return;
  if (!inGraph(ev)) return;

  const node = findNodeUnderCursor(ev);
  if (!node) return;

  watching = true;
  watchedNode = node;
  dragStartPos = [node.pos[0], node.pos[1]];
  lastCheckTime = 0;
  highlightedLink = null;
  matchedSlots = null;
}

function onPointerMove(ev) {
  if (!watching || !watchedNode) return;

  // Throttle
  const now = performance.now();
  if (now - lastCheckTime < THROTTLE_MS) return;
  lastCheckTime = now;

  const node = watchedNode;
  const pos = node.pos;
  const size = node.size;
  if (!pos || !size) return;

  // Check minimum drag distance from start
  const dx = pos[0] - dragStartPos[0];
  const dy = pos[1] - dragStartPos[1];
  if (dx * dx + dy * dy < MIN_DRAG_DIST_SQ) {
    clearHighlight();
    return;
  }

  // Node bounding box in graph space (slightly expanded for tolerance)
  const pad = 10;
  const nodeBox = {
    x1: pos[0] - pad,
    y1: pos[1] - pad,
    x2: pos[0] + size[0] + pad,
    y2: pos[1] + size[1] + pad,
  };

  const nodeCenterX = pos[0] + size[0] / 2;
  const nodeCenterY = pos[1] + size[1] / 2;

  const graph = getCurrentGraph();
  if (!graph) { clearHighlight(); return; }

  const allLinks = collectAllLinks(graph);

  let bestLink = null;
  let bestDistSq = Infinity;
  let bestSlots = null;

  for (const link of allLinks) {
    // Skip links connected to the dragged node itself
    if (link.origin_id === node.id || link.target_id === node.id) continue;

    const srcNode = graph.getNodeById(link.origin_id);
    const dstNode = graph.getNodeById(link.target_id);
    if (!srcNode || !dstNode) continue;

    const srcPos = srcNode.getConnectionPos(false, link.origin_slot);
    const dstPos = dstNode.getConnectionPos(true, link.target_slot);
    if (!srcPos || !dstPos) continue;

    // AABB pre-filter
    const wireBox = bezierAABB(srcPos, dstPos);
    if (!boxesOverlap(nodeBox, wireBox)) continue;

    // Type compatibility — node must have matching input AND output
    const wireType = link.type || srcNode.outputs?.[link.origin_slot]?.type || "*";
    const slots = findBestSlotPair(node, wireType);
    if (!slots) continue;

    // Bezier-vs-box intersection
    if (!bezierIntersectsBox(srcPos, dstPos, nodeBox)) continue;

    // Track closest wire to node center
    const distSq = bezierDistSqToPoint(srcPos, dstPos, nodeCenterX, nodeCenterY);
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestLink = link;
      bestSlots = slots;
    }
  }

  if (bestLink && bestSlots) {
    showHighlight(bestLink, bestSlots, graph);
  } else {
    clearHighlight();
  }
}

function onPointerUp(_ev) {
  if (!watching) return;

  if (highlightedLink && matchedSlots && watchedNode) {
    const graph = getCurrentGraph();
    if (graph) {
      insertNodeOnWire(watchedNode, highlightedLink, matchedSlots, graph);
    }
  }

  clearHighlight();
  resetState();
}

function resetState() {
  watching = false;
  watchedNode = null;
  dragStartPos = null;
  lastCheckTime = 0;
  highlightedLink = null;
  matchedSlots = null;
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "xavis.drop_on_wire",

  settings: [
    {
      id: "xavis.dropOnWire.Enabled",
      name: "Enable Drop Node on Wire",
      type: "boolean",
      defaultValue: true,
      tooltip:
        "Drag a node onto a wire to insert it into the connection. " +
        "The node must have both a compatible input and output for the wire's type.",
      category: ["Xavi's Utils", "Drop on Wire"],
      onChange: (v) => { enabled = !!v; },
    },
  ],

  async setup() {
    // Read initial setting
    try {
      const getSetting = app.extensionManager?.setting?.get
        ?? app.ui?.settings?.getSettingValue;
      if (getSetting) {
        const ctx = app.extensionManager?.setting ?? app.ui?.settings;
        const en = getSetting.call(ctx, "xavis.dropOnWire.Enabled");
        if (en != null) enabled = !!en;
      }
    } catch (_) { /* use defaults */ }

    // Create overlay elements
    ensureOverlay();

    // Attach passive listeners — capture phase, no stopPropagation
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", () => {
      clearHighlight();
      resetState();
    }, true);
  },
});
