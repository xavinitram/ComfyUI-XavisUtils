/**
 * dataflow-highlight.js
 * Xavi's Utils — Highlight Data Flow on Hover
 *
 * Hover over a node to highlight the full upstream and downstream
 * dependency chain. Upstream wires are tinted blue, downstream wires
 * are tinted orange, giving immediate visual insight into data flow.
 * The highlight follows canvas pan/zoom via a requestAnimationFrame loop
 * with dirty-checking to avoid unnecessary work when the canvas is static.
 */

import { app } from "../../scripts/app.js";
import {
  inGraph,
  eventToGraphPos,
  getCurrentGraph,
  resolveLink,
  buildWireSVGPath,
} from "./utils.js";

// ---------------------------------------------------------------------------
// Settings state
// ---------------------------------------------------------------------------
let enabled = true;
let hoverDelayMs = 200;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let hoveredNodeId = null;
let hoverTimer = null;
let upstreamLinks = [];   // link objects feeding into the hovered node (recursively)
let downstreamLinks = []; // link objects fed by the hovered node (recursively)
let animFrameId = null;

// Dirty-checking: only re-render when canvas transform changes
let lastScale = NaN;
let lastOffsetX = NaN;
let lastOffsetY = NaN;

// SVG overlay elements
let svgOverlay = null;
let flowGroup = null;
let pathPool = [];  // { el: SVGPathElement, lastD: string, lastCls: string }

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

  flowGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  flowGroup.classList.add("xavis-flow-group");
  svgOverlay.appendChild(flowGroup);
}

// ---------------------------------------------------------------------------
// Graph traversal — collect upstream/downstream link chains
// ---------------------------------------------------------------------------

function collectUpstreamLinks(nodeId, graph, visited, links) {
  if (visited.has(nodeId)) return;
  visited.add(nodeId);

  const node = graph.getNodeById(nodeId);
  if (!node?.inputs) return;

  for (const inp of node.inputs) {
    if (inp.link == null) continue;
    const link = resolveLink(graph, inp.link);
    if (!link) continue;
    links.push(link);
    collectUpstreamLinks(link.origin_id, graph, visited, links);
  }
}

function collectDownstreamLinks(nodeId, graph, visited, links) {
  if (visited.has(nodeId)) return;
  visited.add(nodeId);

  const node = graph.getNodeById(nodeId);
  if (!node?.outputs) return;

  for (const out of node.outputs) {
    if (!out.links || out.links.length === 0) continue;
    for (const linkId of out.links) {
      const link = resolveLink(graph, linkId);
      if (!link) continue;
      links.push(link);
      collectDownstreamLinks(link.target_id, graph, visited, links);
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering — draw highlighted bezier paths in screen space
// ---------------------------------------------------------------------------

function renderHighlights() {
  const graph = getCurrentGraph();
  if (!graph || !flowGroup) return;

  const canvas = app.canvas;
  if (!canvas?.ds) return;
  const canvasEl = canvas.canvas;
  if (!canvasEl) return;

  const ds = canvas.ds;
  const s = ds.scale;
  const ox = ds.offset[0];
  const oy = ds.offset[1];

  // Dirty check: skip if canvas transform is unchanged since last render
  if (s === lastScale && ox === lastOffsetX && oy === lastOffsetY) return;
  lastScale = s;
  lastOffsetX = ox;
  lastOffsetY = oy;

  // Cache bounding rect once per render — avoids 2N getBoundingClientRect calls
  const rect = canvasEl.getBoundingClientRect();

  const totalLinks = upstreamLinks.length + downstreamLinks.length;

  // Grow pool as needed
  while (pathPool.length < totalLinks) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
    flowGroup.appendChild(el);
    pathPool.push({ el, lastD: "", lastCls: "" });
  }

  let idx = 0;

  for (const link of upstreamLinks) {
    renderLink(pathPool[idx++], link, graph, "xavis-flow-upstream", ds, rect);
  }
  for (const link of downstreamLinks) {
    renderLink(pathPool[idx++], link, graph, "xavis-flow-downstream", ds, rect);
  }

  // Hide unused pool elements
  for (let i = idx; i < pathPool.length; i++) {
    pathPool[i].el.style.display = "none";
  }
}

function renderLink(entry, link, graph, cls, ds, rect) {
  const d = computeBezierPath(link, graph, ds, rect);
  if (d) {
    if (entry.lastD !== d) { entry.el.setAttribute("d", d); entry.lastD = d; }
    if (entry.lastCls !== cls) { entry.el.setAttribute("class", cls); entry.lastCls = cls; }
    if (entry.el.style.display === "none") entry.el.style.display = "";
  } else {
    entry.el.style.display = "none";
  }
}

function computeBezierPath(link, graph, ds, rect) {
  const srcNode = graph.getNodeById(link.origin_id);
  const dstNode = graph.getNodeById(link.target_id);
  if (!srcNode || !dstNode) return null;

  const srcPos = srcNode.getConnectionPos(false, link.origin_slot);
  const dstPos = dstNode.getConnectionPos(true, link.target_slot);
  if (!srcPos || !dstPos) return null;

  // Graph→screen conversion using cached rect (no per-call getBoundingClientRect)
  const sx0 = srcPos[0] * ds.scale + ds.offset[0] + rect.left;
  const sy0 = srcPos[1] * ds.scale + ds.offset[1] + rect.top;
  const sx1 = dstPos[0] * ds.scale + ds.offset[0] + rect.left;
  const sy1 = dstPos[1] * ds.scale + ds.offset[1] + rect.top;

  return buildWireSVGPath(sx0, sy0, sx1, sy1);
}

// ---------------------------------------------------------------------------
// Animation loop — keeps highlight aligned during pan/zoom
// ---------------------------------------------------------------------------

function startRenderLoop() {
  // Force first render by invalidating dirty-check cache
  lastScale = NaN;
  lastOffsetX = NaN;
  lastOffsetY = NaN;

  function frame() {
    if (hoveredNodeId == null) return;
    renderHighlights();
    animFrameId = requestAnimationFrame(frame);
  }
  animFrameId = requestAnimationFrame(frame);
}

function stopRenderLoop() {
  if (animFrameId != null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  clearHighlights();
}

function clearHighlights() {
  for (const entry of pathPool) {
    entry.el.style.display = "none";
    entry.lastD = "";
    entry.lastCls = "";
  }
}

// ---------------------------------------------------------------------------
// Hover detection
// ---------------------------------------------------------------------------

function activateHighlight(nodeId) {
  const graph = getCurrentGraph();
  if (!graph) return;

  hoveredNodeId = nodeId;

  // Trace the full dependency chain
  upstreamLinks = [];
  downstreamLinks = [];
  collectUpstreamLinks(nodeId, graph, new Set(), upstreamLinks);
  collectDownstreamLinks(nodeId, graph, new Set(), downstreamLinks);

  // Nothing to highlight — don't start the loop
  if (upstreamLinks.length === 0 && downstreamLinks.length === 0) {
    hoveredNodeId = null;
    return;
  }

  startRenderLoop();
}

function deactivateHighlight() {
  hoveredNodeId = null;
  upstreamLinks = [];
  downstreamLinks = [];
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  stopRenderLoop();
}

// ---------------------------------------------------------------------------
// Pointer listener — detect which node is under cursor
// ---------------------------------------------------------------------------

function onPointerMove(ev) {
  if (!enabled) {
    if (hoveredNodeId != null) deactivateHighlight();
    return;
  }
  if (!inGraph(ev)) {
    if (hoveredNodeId != null) deactivateHighlight();
    return;
  }

  const graphPos = eventToGraphPos(ev);
  if (!graphPos) {
    if (hoveredNodeId != null) deactivateHighlight();
    return;
  }

  const graph = getCurrentGraph();
  if (!graph) {
    if (hoveredNodeId != null) deactivateHighlight();
    return;
  }

  const node = graph.getNodeOnPos(graphPos[0], graphPos[1], graph._nodes);
  const nodeId = node ? node.id : null;

  if (nodeId === hoveredNodeId) return; // same node — no change

  // Node changed
  if (hoveredNodeId != null) deactivateHighlight();

  if (nodeId == null) return; // cursor moved to empty canvas

  // Start hover delay
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    activateHighlight(nodeId);
  }, hoverDelayMs);
}

// Also deactivate on pointerdown — user is starting an interaction
function onPointerDown(_ev) {
  if (hoveredNodeId != null) deactivateHighlight();
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "xavis.dataflow_highlight",

  settings: [
    {
      id: "xavis.dataflowHighlight.Enabled",
      name: "Enable Dataflow Highlight",
      type: "boolean",
      defaultValue: true,
      tooltip:
        "Hover over a node to highlight its full upstream (blue) and " +
        "downstream (orange) dependency chain. Provides instant visual " +
        "insight into data flow through complex graphs.",
      category: ["Xavi's Utils", "Dataflow Highlight"],
      onChange: (v) => {
        enabled = !!v;
        if (!enabled) deactivateHighlight();
      },
    },
    {
      id: "xavis.dataflowHighlight.HoverDelay",
      name: "Hover delay (ms)",
      type: "number",
      defaultValue: 200,
      tooltip:
        "Milliseconds to hover over a node before the highlight appears. " +
        "Lower values feel more responsive but may flicker during fast mouse movement.",
      category: ["Xavi's Utils", "Dataflow Highlight"],
      attrs: { min: 0, max: 1000, step: 50 },
      onChange: (v) => { hoverDelayMs = Number(v) || 200; },
    },
  ],

  async setup() {
    // Read initial settings
    try {
      const getSetting = app.extensionManager?.setting?.get
        ?? app.ui?.settings?.getSettingValue;
      if (getSetting) {
        const ctx = app.extensionManager?.setting ?? app.ui?.settings;

        const en = getSetting.call(ctx, "xavis.dataflowHighlight.Enabled");
        if (en != null) enabled = !!en;

        const d = getSetting.call(ctx, "xavis.dataflowHighlight.HoverDelay");
        if (d != null) hoverDelayMs = Number(d) || 200;
      }
    } catch (_) { /* use defaults */ }

    // Create overlay elements
    ensureOverlay();

    // Pointer listeners — capture phase, passive monitoring
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerdown", onPointerDown, true);
  },
});
