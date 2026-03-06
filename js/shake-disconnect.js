/**
 * shake-disconnect.js
 * Xavi's Utils — Shake to Disconnect + Re-wire
 *
 * While LiteGraph is dragging a node, we passively track pointer motion.
 * If rapid horizontal direction reversals are detected (a "shake"),
 * we disconnect the node and re-wire pass-through connections where types match.
 */

import { app } from "../../scripts/app.js";
import { inGraph, findNodeUnderCursor, getCurrentGraph, graphPosToScreen } from "./utils.js";

// ---------------------------------------------------------------------------
// Load shared gesture CSS
// ---------------------------------------------------------------------------
const gestureCSS = document.createElement("link");
gestureCSS.rel = "stylesheet";
gestureCSS.href = new URL("./gesture-styles.css", import.meta.url).href;
document.head.appendChild(gestureCSS);

// ---------------------------------------------------------------------------
// Settings state
// ---------------------------------------------------------------------------
let enabled = true;
let requiredReversals = 3;
let windowMs = 400;

// ---------------------------------------------------------------------------
// Shake detection state
// ---------------------------------------------------------------------------
let watching = false;
let watchedNode = null;
let lastPointerX = 0;
let lastDirection = 0; // -1 = left, +1 = right, 0 = undetermined
let reversalTimestamps = []; // timestamps of direction reversals

// Minimum pixels of movement to count as a direction
const MIN_MOVE_PX = 4;

// ---------------------------------------------------------------------------
// Core detection
// ---------------------------------------------------------------------------

function onPointerDown(ev) {
  if (!enabled) return;
  if (ev.button !== 0) return; // left click only (node drag)
  if (!inGraph(ev)) return;

  // Check if there's a node under cursor
  const node = findNodeUnderCursor(ev);
  if (!node) return;

  // Enter watching state — we don't interfere with LiteGraph's drag
  watching = true;
  watchedNode = node;
  lastPointerX = ev.clientX;
  lastDirection = 0;
  reversalTimestamps = [];
}

function onPointerMove(ev) {
  if (!watching || !watchedNode) return;

  const dx = ev.clientX - lastPointerX;
  if (Math.abs(dx) < MIN_MOVE_PX) return;

  const newDir = dx > 0 ? 1 : -1;
  const now = performance.now();

  if (lastDirection !== 0 && newDir !== lastDirection) {
    // Direction reversal detected
    reversalTimestamps.push(now);

    // Trim old timestamps outside the window
    const cutoff = now - windowMs;
    reversalTimestamps = reversalTimestamps.filter(t => t >= cutoff);

    if (reversalTimestamps.length >= requiredReversals) {
      // Shake detected!
      triggerDisconnect(watchedNode);
      resetState();
      return;
    }
  }

  lastDirection = newDir;
  lastPointerX = ev.clientX;
}

function onPointerUp(_ev) {
  resetState();
}

function resetState() {
  watching = false;
  watchedNode = null;
  lastPointerX = 0;
  lastDirection = 0;
  reversalTimestamps = [];
}

// ---------------------------------------------------------------------------
// Disconnect + re-wire
// ---------------------------------------------------------------------------

function triggerDisconnect(node) {
  const graph = getCurrentGraph();
  const canvas = app.canvas;
  if (!graph || !canvas) return;

  // Refresh node reference from graph (in case of ID mismatch)
  const liveNode = graph.getNodeById(node.id);
  if (!liveNode) return;

  // ----- Step 1: Collect all input connections -----
  const inputLinks = []; // { upstreamNode, upstreamSlot, inputIndex, type }
  if (liveNode.inputs) {
    for (let i = 0; i < liveNode.inputs.length; i++) {
      const inp = liveNode.inputs[i];
      if (inp.link == null) continue;
      const link = graph.links?.[inp.link] || graph._links?.get?.(inp.link);
      if (!link) continue;
      const upNode = graph.getNodeById(link.origin_id);
      if (!upNode) continue;
      inputLinks.push({
        upstreamNode: upNode,
        upstreamSlot: link.origin_slot,
        inputIndex: i,
        type: inp.type,
      });
    }
  }

  // ----- Step 2: Collect all output connections -----
  const outputLinks = []; // { downstreamNode, downstreamSlot, outputIndex, type }
  if (liveNode.outputs) {
    for (let i = 0; i < liveNode.outputs.length; i++) {
      const out = liveNode.outputs[i];
      if (!out.links || out.links.length === 0) continue;
      for (const linkId of out.links) {
        const link = graph.links?.[linkId] || graph._links?.get?.(linkId);
        if (!link) continue;
        const downNode = graph.getNodeById(link.target_id);
        if (!downNode) continue;
        outputLinks.push({
          downstreamNode: downNode,
          downstreamSlot: link.target_slot,
          outputIndex: i,
          type: out.type,
        });
      }
    }
  }

  // ----- Step 3: Build pass-through map -----
  // For each input type, find matching outputs of the same type.
  // Match by index within same-type groups:
  //   1st IMAGE in -> 1st IMAGE out, 2nd IMAGE in -> 2nd IMAGE out, etc.
  const inputsByType = {};
  for (const il of inputLinks) {
    const t = il.type || "*";
    if (!inputsByType[t]) inputsByType[t] = [];
    inputsByType[t].push(il);
  }

  const outputsByType = {};
  for (const ol of outputLinks) {
    const t = ol.type || "*";
    if (!outputsByType[t]) outputsByType[t] = [];
    outputsByType[t].push(ol);
  }

  // ----- Step 4: Create bypass connections BEFORE disconnecting -----
  // This is critical — we need the connection info still intact.
  //
  // Strategy per type:
  //   - 1:1 pairing by index (1st IMAGE in → 1st IMAGE out, etc.)
  //   - If more downstream connections than inputs, remaining downstream
  //     nodes connect to the last matched upstream node (fan-out).
  //   - If more inputs than outputs, extra inputs have no downstream match
  //     and are simply disconnected.
  for (const type of Object.keys(inputsByType)) {
    const ins = inputsByType[type];
    const outs = outputsByType[type] || [];
    if (outs.length === 0) continue;

    const pairCount = Math.min(ins.length, outs.length);

    // 1:1 pairing
    for (let i = 0; i < pairCount; i++) {
      ins[i].upstreamNode.connect(
        ins[i].upstreamSlot,
        outs[i].downstreamNode,
        outs[i].downstreamSlot
      );
    }

    // Fan-out remaining downstream connections to last upstream
    if (outs.length > pairCount) {
      const lastUpstream = ins[pairCount - 1];
      for (let i = pairCount; i < outs.length; i++) {
        lastUpstream.upstreamNode.connect(
          lastUpstream.upstreamSlot,
          outs[i].downstreamNode,
          outs[i].downstreamSlot
        );
      }
    }
  }

  // ----- Step 5: Disconnect ALL connections from the node -----
  if (liveNode.inputs) {
    for (let i = liveNode.inputs.length - 1; i >= 0; i--) {
      if (liveNode.inputs[i].link != null) {
        liveNode.disconnectInput(i);
      }
    }
  }
  if (liveNode.outputs) {
    for (let i = liveNode.outputs.length - 1; i >= 0; i--) {
      if (liveNode.outputs[i].links && liveNode.outputs[i].links.length > 0) {
        liveNode.disconnectOutput(i);
      }
    }
  }

  // ----- Step 6: Mark dirty + visual feedback -----
  canvas.setDirty(true, true);
  showShakeFlash(liveNode);

  console.log(
    `[Xavi's Utils] Shake disconnect: ${liveNode.type || liveNode.comfyClass} #${liveNode.id}` +
    ` (re-wired ${inputLinks.length} inputs, ${outputLinks.length} outputs)`
  );
}

// ---------------------------------------------------------------------------
// Visual feedback — brief red flash overlay on the disconnected node
// ---------------------------------------------------------------------------

function showShakeFlash(node) {
  const pos = node.pos;
  const size = node.size;
  if (!pos || !size) return;

  // Convert node bounds to screen coordinates
  const topLeft = graphPosToScreen(pos[0], pos[1]);
  const bottomRight = graphPosToScreen(pos[0] + size[0], pos[1] + size[1]);
  if (!topLeft || !bottomRight) return;

  const flash = document.createElement("div");
  flash.className = "xavis-shake-flash";
  flash.style.left = `${topLeft[0]}px`;
  flash.style.top = `${topLeft[1]}px`;
  flash.style.width = `${bottomRight[0] - topLeft[0]}px`;
  flash.style.height = `${bottomRight[1] - topLeft[1]}px`;

  document.body.appendChild(flash);
  flash.addEventListener("animationend", () => flash.remove());
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "xavis.shake_disconnect",

  settings: [
    {
      id: "xavis.shake.Enabled",
      name: "Enable Shake to Disconnect",
      type: "boolean",
      defaultValue: true,
      tooltip:
        "Rapidly shake a node while dragging to disconnect it. " +
        "Pass-through connections are re-wired where types match.",
      category: ["Xavi's Utils", "Shake Disconnect"],
      onChange: (v) => { enabled = !!v; },
    },
    {
      id: "xavis.shake.Reversals",
      name: "Direction reversals to trigger",
      type: "number",
      defaultValue: 3,
      tooltip: "Number of rapid left-right direction changes needed to trigger a shake disconnect.",
      category: ["Xavi's Utils", "Shake Disconnect"],
      attrs: { min: 2, max: 6, step: 1 },
      onChange: (v) => { requiredReversals = Number(v) || 3; },
    },
    {
      id: "xavis.shake.WindowMs",
      name: "Time window (ms)",
      type: "number",
      defaultValue: 400,
      tooltip: "All direction reversals must occur within this time window (ms) to count as a shake.",
      category: ["Xavi's Utils", "Shake Disconnect"],
      attrs: { min: 200, max: 800, step: 50 },
      onChange: (v) => { windowMs = Number(v) || 400; },
    },
  ],

  async setup() {
    // Read initial settings
    try {
      const getSetting = app.extensionManager?.setting?.get
        ?? app.ui?.settings?.getSettingValue;
      if (getSetting) {
        const ctx = app.extensionManager?.setting ?? app.ui?.settings;

        const en = getSetting.call(ctx, "xavis.shake.Enabled");
        if (en != null) enabled = !!en;

        const r = getSetting.call(ctx, "xavis.shake.Reversals");
        if (r != null) requiredReversals = Number(r) || 3;

        const w = getSetting.call(ctx, "xavis.shake.WindowMs");
        if (w != null) windowMs = Number(w) || 400;
      }
    } catch (_) { /* use defaults */ }

    // Attach listeners — capture phase but DO NOT stop propagation
    // We passively watch LiteGraph's normal node drag.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerUp, true);

    console.log("[Xavi's Utils] Shake Disconnect loaded.");
  },
});
