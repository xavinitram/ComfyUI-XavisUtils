/**
 * wire-knife.js
 * Xavi's Utils — Y + Drag Knife to Cut Wires
 *
 * Hold Y key, then click and drag to draw a knife line.
 * Any wires (LiteGraph links) intersecting the knife line are disconnected.
 * Inspired by Houdini's wire-cutting UX.
 */

import { app } from "../../scripts/app.js";
import { inGraph, eventToGraphPos, getCurrentGraph, GRAPH_SELECTOR } from "./utils.js";

// ---------------------------------------------------------------------------
// Settings state
// ---------------------------------------------------------------------------
let enabled = true;

// ---------------------------------------------------------------------------
// State machine: IDLE -> ARMED (Y held) -> CUTTING (Y + drag) -> IDLE
// ---------------------------------------------------------------------------
let knifeState = "IDLE";
let startScreen = null; // [x, y] screen coords
let endScreen = null;   // [x, y] screen coords
let startGraph = null;  // [x, y] graph coords
let endGraph = null;    // [x, y] graph coords

// SVG overlay elements
let svgOverlay = null;
let knifeLine = null;

// Track which canvas elements we applied the cursor class to
let armedElements = [];

// ---------------------------------------------------------------------------
// SVG overlay management
// ---------------------------------------------------------------------------

function ensureOverlay() {
  if (svgOverlay) return;
  svgOverlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svgOverlay.classList.add("xavis-gesture-overlay");
  document.body.appendChild(svgOverlay);

  knifeLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
  knifeLine.classList.add("xavis-knife-line");
  knifeLine.style.display = "none";
  svgOverlay.appendChild(knifeLine);
}

function showKnifeLine(x1, y1, x2, y2) {
  if (!knifeLine) return;
  knifeLine.setAttribute("x1", x1);
  knifeLine.setAttribute("y1", y1);
  knifeLine.setAttribute("x2", x2);
  knifeLine.setAttribute("y2", y2);
  knifeLine.style.display = "";
}

function hideKnifeLine() {
  if (knifeLine) knifeLine.style.display = "none";
}

// ---------------------------------------------------------------------------
// Armed cursor management
// ---------------------------------------------------------------------------

function setArmedCursor() {
  const els = document.querySelectorAll(GRAPH_SELECTOR);
  armedElements = [...els];
  for (const el of armedElements) {
    el.classList.add("xavis-knife-armed");
  }
}

function clearArmedCursor() {
  for (const el of armedElements) {
    el.classList.remove("xavis-knife-armed");
  }
  armedElements = [];
}

// ---------------------------------------------------------------------------
// Keyboard listeners
// ---------------------------------------------------------------------------

function onKeyDown(ev) {
  if (!enabled) return;
  if (ev.key !== "y" && ev.key !== "Y") return;
  if (ev.repeat) return; // ignore key repeat
  if (knifeState !== "IDLE") return;

  // Don't arm if focus is in an input/textarea/contenteditable
  const tag = ev.target?.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || ev.target?.isContentEditable) return;

  knifeState = "ARMED";
  setArmedCursor();
}

function onKeyUp(ev) {
  if (ev.key !== "y" && ev.key !== "Y") return;

  if (knifeState === "ARMED") {
    // Y released before clicking — cancel
    knifeState = "IDLE";
    clearArmedCursor();
  } else if (knifeState === "CUTTING") {
    // Y released during drag — finish the cut
    finishCut();
  }
}

// ---------------------------------------------------------------------------
// Pointer listeners
// ---------------------------------------------------------------------------

function onPointerDown(ev) {
  if (!enabled) return;
  if (knifeState !== "ARMED") return;
  if (ev.button !== 0) return; // left click only
  if (!inGraph(ev)) return;

  // Intercept — prevent LiteGraph from handling this click
  ev.stopPropagation();
  ev.preventDefault();

  startScreen = [ev.clientX, ev.clientY];
  endScreen = [ev.clientX, ev.clientY];
  startGraph = eventToGraphPos(ev);
  endGraph = startGraph ? [...startGraph] : null;

  knifeState = "CUTTING";
  ensureOverlay();
}

function onPointerMove(ev) {
  if (knifeState !== "CUTTING") return;

  ev.stopPropagation();
  ev.preventDefault();

  endScreen = [ev.clientX, ev.clientY];
  endGraph = eventToGraphPos(ev);

  showKnifeLine(startScreen[0], startScreen[1], endScreen[0], endScreen[1]);
}

function onPointerUp(ev) {
  if (knifeState !== "CUTTING") return;

  ev.stopPropagation();
  ev.preventDefault();

  endScreen = [ev.clientX, ev.clientY];
  endGraph = eventToGraphPos(ev);

  finishCut();
}

// ---------------------------------------------------------------------------
// Cut logic — find intersecting wires and disconnect them
// ---------------------------------------------------------------------------

function finishCut() {
  if (startGraph && endGraph) {
    const cutCount = cutIntersectingLinks(startGraph, endGraph);
    if (cutCount > 0) {
      console.log(`[Xavi's Utils] Wire Knife: cut ${cutCount} wire(s).`);
    }
  }

  // Reset state
  hideKnifeLine();
  clearArmedCursor();
  knifeState = "IDLE";
  startScreen = null;
  endScreen = null;
  startGraph = null;
  endGraph = null;
}

/**
 * Find all links intersecting the knife line and disconnect them.
 * @param {[number,number]} p0 - knife start in graph space
 * @param {[number,number]} p1 - knife end in graph space
 * @returns {number} count of wires cut
 */
function cutIntersectingLinks(p0, p1) {
  const graph = getCurrentGraph();
  const canvas = app.canvas;
  if (!graph || !canvas) return 0;

  // Collect all link objects
  const allLinks = [];
  if (graph.links) {
    // links can be an array (sparse) or a Map
    if (graph.links instanceof Map || graph._links instanceof Map) {
      const map = graph._links || graph.links;
      map.forEach((link) => { if (link) allLinks.push(link); });
    } else if (Array.isArray(graph.links)) {
      for (const link of graph.links) {
        if (link) allLinks.push(link);
      }
    } else {
      // Object (sparse array-like)
      for (const key of Object.keys(graph.links)) {
        const link = graph.links[key];
        if (link) allLinks.push(link);
      }
    }
  }

  const linksToRemove = [];

  for (const link of allLinks) {
    const srcNode = graph.getNodeById(link.origin_id);
    const dstNode = graph.getNodeById(link.target_id);
    if (!srcNode || !dstNode) continue;

    const srcPos = srcNode.getConnectionPos(false, link.origin_slot);
    const dstPos = dstNode.getConnectionPos(true, link.target_slot);
    if (!srcPos || !dstPos) continue;

    // Sample the bezier curve and test for intersection
    if (bezierIntersectsLine(srcPos, dstPos, p0, p1)) {
      linksToRemove.push(link);
    }
  }

  // Disconnect all intersecting links
  for (const link of linksToRemove) {
    const dstNode = graph.getNodeById(link.target_id);
    if (dstNode) {
      dstNode.disconnectInput(link.target_slot);
    }
  }

  if (linksToRemove.length > 0) {
    canvas.setDirty(true, true);
  }

  return linksToRemove.length;
}

// ---------------------------------------------------------------------------
// Bezier-Line intersection
// ---------------------------------------------------------------------------

/**
 * Test if a cubic bezier (representing a LiteGraph wire) intersects a line segment.
 * LiteGraph bezier control points follow a horizontal pattern:
 *   P0 = srcPos
 *   P1 = srcPos + [dist * 0.5, 0]
 *   P2 = dstPos - [dist * 0.5, 0]
 *   P3 = dstPos
 *
 * We sample 20 points on the curve and test each consecutive pair
 * against the knife line segment.
 */
function bezierIntersectsLine(srcPos, dstPos, lineA, lineB) {
  const SAMPLES = 20;

  // Compute control points (same as LiteGraph rendering)
  const dx = Math.abs(dstPos[0] - srcPos[0]);
  const offsetX = Math.max(dx * 0.5, 40); // minimum curvature

  const cp0 = srcPos;
  const cp1 = [srcPos[0] + offsetX, srcPos[1]];
  const cp2 = [dstPos[0] - offsetX, dstPos[1]];
  const cp3 = dstPos;

  let prevPt = evalCubic(cp0, cp1, cp2, cp3, 0);

  for (let i = 1; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const pt = evalCubic(cp0, cp1, cp2, cp3, t);

    if (segmentsIntersect(prevPt, pt, lineA, lineB)) {
      return true;
    }

    prevPt = pt;
  }

  return false;
}

/** Evaluate cubic bezier at parameter t. */
function evalCubic(p0, p1, p2, p3, t) {
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

/**
 * Test if two line segments (a0-a1) and (b0-b1) intersect.
 * Standard 2D cross-product method.
 */
function segmentsIntersect(a0, a1, b0, b1) {
  const d1x = a1[0] - a0[0];
  const d1y = a1[1] - a0[1];
  const d2x = b1[0] - b0[0];
  const d2y = b1[1] - b0[1];

  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-10) return false; // parallel

  const dx = b0[0] - a0[0];
  const dy = b0[1] - a0[1];

  const t = (dx * d2y - dy * d2x) / denom;
  const u = (dx * d1y - dy * d1x) / denom;

  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "xavis.wire_knife",

  settings: [
    {
      id: "xavis.knife.Enabled",
      name: "Enable Wire Knife (Y + Drag)",
      type: "boolean",
      defaultValue: true,
      tooltip:
        "Hold Y and drag to draw a knife line that cuts any wires it crosses. " +
        "Inspired by Houdini.",
      category: ["Xavi's Utils", "Wire Knife"],
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
        const en = getSetting.call(ctx, "xavis.knife.Enabled");
        if (en != null) enabled = !!en;
      }
    } catch (_) { /* use defaults */ }

    // Create the SVG overlay now so it's ready
    ensureOverlay();

    // Key listeners — always on document (not capture needed)
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);

    // Pointer listeners — capture phase so we can intercept before LiteGraph
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", () => {
      if (knifeState === "CUTTING") finishCut();
    }, true);

    console.log("[Xavi's Utils] Wire Knife loaded.");
  },
});
