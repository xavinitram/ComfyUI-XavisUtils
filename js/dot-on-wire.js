/**
 * dot-on-wire.js
 * Xavi's Utils — Double-Click Wire to Insert Reroute
 *
 * Double-click on an existing wire to insert a Reroute (dot) node at that
 * position. The original connection is split: source → reroute → target.
 * Double-clicks that miss a wire pass through to ComfyUI (e.g. open search).
 * Inspired by Houdini and Nuke's dot/dot insertion UX.
 */

import { app } from "../../scripts/app.js";
import {
  inGraph,
  eventToGraphPos,
  getCurrentGraph,
  collectAllLinks,
  evalCubic,
  bezierControlPoints,
  showInsertFlash,
} from "./utils.js";

// ---------------------------------------------------------------------------
// Settings state
// ---------------------------------------------------------------------------
let enabled = true;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SCREEN_HIT_THRESHOLD = 15;  // pixels on screen
const BEZIER_SAMPLES = 24;

// ---------------------------------------------------------------------------
// Bezier distance (uses shared evalCubic / bezierControlPoints from utils.js)
// ---------------------------------------------------------------------------

/**
 * Find the minimum squared distance from a point to a sampled bezier curve.
 */
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
// Reroute creation
// ---------------------------------------------------------------------------

function createRerouteNode() {
  // Try the standard ComfyUI reroute node type
  let reroute = LiteGraph.createNode("Reroute");
  if (reroute) return reroute;

  // Fallback names used in some ComfyUI versions
  reroute = LiteGraph.createNode("RerouteNode");
  if (reroute) return reroute;

  return null;
}

function insertReroute(link, graphPos, graph) {
  const canvas = app.canvas;
  if (!canvas) return false;

  const srcNode = graph.getNodeById(link.origin_id);
  const dstNode = graph.getNodeById(link.target_id);
  if (!srcNode || !dstNode) return false;

  const reroute = createRerouteNode();
  if (!reroute) {
    console.warn("[Xavi's Utils] Dot on Wire: Reroute node type not found.");
    return false;
  }

  // Position the reroute centred on the click point
  const w = reroute.size?.[0] || 40;
  const h = reroute.size?.[1] || 30;
  reroute.pos = [graphPos[0] - w / 2, graphPos[1] - h / 2];
  graph.add(reroute);

  const originSlot = link.origin_slot;
  const targetSlot = link.target_slot;

  // Step 1: Disconnect original wire
  dstNode.disconnectInput(targetSlot);

  // Step 2: Source output → Reroute input 0
  srcNode.connect(originSlot, reroute, 0);

  // Step 3: Reroute output 0 → original target input
  reroute.connect(0, dstNode, targetSlot);

  canvas.setDirty(true, true);
  showInsertFlash(reroute);

  return true;
}

// ---------------------------------------------------------------------------
// Double-click handler
// ---------------------------------------------------------------------------

function onDblClick(ev) {
  if (!enabled) return;
  if (!inGraph(ev)) return;

  const graph = getCurrentGraph();
  if (!graph) return;

  const graphPos = eventToGraphPos(ev);
  if (!graphPos) return;
  const [gx, gy] = graphPos;

  // Only act on empty canvas — no node or group under cursor
  if (graph.getNodeOnPos(gx, gy, graph._nodes)) return;
  if (graph.getGroupOnPos?.(gx, gy)) return;

  // Compute hit threshold in graph space (scales with zoom)
  const scale = app.canvas?.ds?.scale || 1;
  const graphThreshold = SCREEN_HIT_THRESHOLD / scale;
  const thresholdSq = graphThreshold * graphThreshold;

  // Find the closest wire to the click
  const allLinks = collectAllLinks(graph);
  let bestLink = null;
  let bestDistSq = Infinity;

  for (const link of allLinks) {
    const srcNode = graph.getNodeById(link.origin_id);
    const dstNode = graph.getNodeById(link.target_id);
    if (!srcNode || !dstNode) continue;

    const srcPos = srcNode.getConnectionPos(false, link.origin_slot);
    const dstPos = dstNode.getConnectionPos(true, link.target_slot);
    if (!srcPos || !dstPos) continue;

    // AABB pre-filter — skip wires whose bounding box doesn't contain the click
    const dx = Math.abs(dstPos[0] - srcPos[0]);
    const offsetX = Math.max(dx * 0.5, 40);
    if (gx < Math.min(srcPos[0], dstPos[0] - offsetX) - graphThreshold) continue;
    if (gx > Math.max(srcPos[0] + offsetX, dstPos[0]) + graphThreshold) continue;
    if (gy < Math.min(srcPos[1], dstPos[1]) - graphThreshold) continue;
    if (gy > Math.max(srcPos[1], dstPos[1]) + graphThreshold) continue;

    const distSq = bezierDistSqToPoint(srcPos, dstPos, gx, gy);
    if (distSq < thresholdSq && distSq < bestDistSq) {
      bestDistSq = distSq;
      bestLink = link;
    }
  }

  if (!bestLink) return; // No wire hit — let ComfyUI handle the dblclick

  // Wire hit — intercept the event and insert a reroute
  ev.stopPropagation();
  ev.preventDefault();

  insertReroute(bestLink, graphPos, graph);
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "xavis.dot_on_wire",

  settings: [
    {
      id: "xavis.dotOnWire.Enabled",
      name: "Enable Dot on Wire (double-click)",
      type: "boolean",
      defaultValue: true,
      tooltip:
        "Double-click on a wire to insert a Reroute (dot) node at that position. " +
        "The original connection is split through the reroute. " +
        "Double-clicks that miss a wire pass through to ComfyUI normally.",
      category: ["Xavi's Utils", "Dot on Wire"],
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
        const en = getSetting.call(ctx, "xavis.dotOnWire.Enabled");
        if (en != null) enabled = !!en;
      }
    } catch (_) { /* use defaults */ }

    // Capture phase — intercept before ComfyUI/LiteGraph handles the dblclick
    document.addEventListener("dblclick", onDblClick, true);
  },
});
