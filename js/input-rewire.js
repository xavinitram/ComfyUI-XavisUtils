/**
 * input-rewire.js
 * Xavi's Utils — Input Rewire (drag from input to output)
 *
 * Dragging from a connected input slot starts a new wire.
 * Drop on a compatible output to create a new connection (old wire auto-replaced).
 * Drop on empty space — old connection is preserved (nothing changes).
 *
 * This makes input/output behavior symmetrical, like in Houdini and Nuke.
 * LiteGraph does NOT natively support "connecting from input" — we handle
 * the entire interaction ourselves, intercepting events before LiteGraph.
 */

import { app } from "../../scripts/app.js";
import {
  inGraph,
  eventToGraphPos,
  graphPosToScreen,
  findSlotUnderCursor,
} from "./utils.js";

// ---------------------------------------------------------------------------
// Settings state
// ---------------------------------------------------------------------------
let enabled = true;

// ---------------------------------------------------------------------------
// State: IDLE | DRAGGING
// ---------------------------------------------------------------------------
let dragState = "IDLE";

// Drag context — set when DRAGGING
let dragNode = null;       // the node whose input we're dragging from
let dragInputIndex = -1;   // the input slot index
let dragInputType = null;  // type string for compatibility check
let dragOldLinkId = null;  // the existing link ID on this input

// SVG overlay
let svgOverlay = null;
let wirePreview = null;    // <path> element for bezier preview
let slotHighlight = null;  // <circle> element for output slot highlight

// Wire color from type
const TYPE_COLORS = {
  IMAGE: "#64b5f6",
  MASK: "#ffffff",
  LATENT: "#ff9cf9",
  MODEL: "#b39ddb",
  CLIP: "#fdd835",
  VAE: "#ff6e6e",
  CONDITIONING: "#ffa931",
  CONTROL_NET: "#00d78a",
  INT: "#29699c",
  FLOAT: "#a1d5a1",
  STRING: "#8ae68a",
  "*": "#aaaaaa",
};

function getWireColor(type) {
  if (!type) return TYPE_COLORS["*"];

  // Check LiteGraph's registered type colors first
  const lgColors = LiteGraph?.registered_slot_out_types;
  if (lgColors && lgColors[type]?.color) {
    return lgColors[type].color;
  }

  return TYPE_COLORS[type] || TYPE_COLORS["*"];
}

// ---------------------------------------------------------------------------
// SVG overlay management
// ---------------------------------------------------------------------------

function ensureOverlay() {
  if (svgOverlay) return;

  // Reuse knife overlay if it already exists
  svgOverlay = document.querySelector(".xavis-gesture-overlay");
  if (!svgOverlay) {
    svgOverlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svgOverlay.classList.add("xavis-gesture-overlay");
    document.body.appendChild(svgOverlay);
  }

  wirePreview = document.createElementNS("http://www.w3.org/2000/svg", "path");
  wirePreview.classList.add("xavis-wire-preview");
  wirePreview.style.display = "none";
  svgOverlay.appendChild(wirePreview);

  slotHighlight = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  slotHighlight.classList.add("xavis-slot-highlight");
  slotHighlight.setAttribute("r", "8");
  slotHighlight.style.display = "none";
  svgOverlay.appendChild(slotHighlight);
}

function showWirePreview(fromScreen, toScreen, color) {
  if (!wirePreview) return;

  const dx = Math.abs(toScreen[0] - fromScreen[0]);
  const offsetX = Math.max(dx * 0.5, 30);

  // Bezier from input (left side) curving to cursor
  // Input is on the left, so control points go leftward from input, rightward to cursor
  const cp1x = fromScreen[0] - offsetX;
  const cp2x = toScreen[0] + offsetX;

  const d = `M ${fromScreen[0]} ${fromScreen[1]} C ${cp1x} ${fromScreen[1]}, ${cp2x} ${toScreen[1]}, ${toScreen[0]} ${toScreen[1]}`;

  wirePreview.setAttribute("d", d);
  wirePreview.setAttribute("stroke", color);
  wirePreview.style.display = "";
}

function hideWirePreview() {
  if (wirePreview) wirePreview.style.display = "none";
  if (slotHighlight) slotHighlight.style.display = "none";
}

function showSlotHighlight(screenPos) {
  if (!slotHighlight) return;
  slotHighlight.setAttribute("cx", screenPos[0]);
  slotHighlight.setAttribute("cy", screenPos[1]);
  slotHighlight.style.display = "";
}

function hideSlotHighlight() {
  if (slotHighlight) slotHighlight.style.display = "none";
}

// ---------------------------------------------------------------------------
// Pointer listeners
// ---------------------------------------------------------------------------

function onPointerDown(ev) {
  if (!enabled) return;
  if (dragState !== "IDLE") return;
  if (ev.button !== 0) return; // left click only
  if (ev.ctrlKey || ev.altKey || ev.shiftKey || ev.metaKey) return; // no modifiers
  if (!inGraph(ev)) return;

  // Hit-test input slots
  const hit = findSlotUnderCursor(ev, "input");
  if (!hit) return;

  // Only intercept if the input has an existing connection
  const input = hit.slot;
  if (input.link == null) return;

  // We found a connected input — intercept this event
  ev.stopPropagation();
  ev.preventDefault();

  dragState = "DRAGGING";
  dragNode = hit.node;
  dragInputIndex = hit.slotIndex;
  dragInputType = input.type || "*";
  dragOldLinkId = input.link;

  ensureOverlay();
}

function onPointerMove(ev) {
  if (dragState !== "DRAGGING") return;

  ev.stopPropagation();
  ev.preventDefault();

  // Get the input slot position in screen space
  const inputPos = dragNode.getConnectionPos(true, dragInputIndex);
  if (!inputPos) return;

  const inputScreen = graphPosToScreen(inputPos[0], inputPos[1]);
  if (!inputScreen) return;

  const cursorScreen = [ev.clientX, ev.clientY];
  const color = getWireColor(dragInputType);

  showWirePreview(inputScreen, cursorScreen, color);

  // Check if cursor is near an output slot — show highlight
  const outputHit = findSlotUnderCursor(ev, "output");
  if (outputHit) {
    const outputPos = outputHit.node.getConnectionPos(false, outputHit.slotIndex);
    if (outputPos) {
      const outputScreen = graphPosToScreen(outputPos[0], outputPos[1]);
      if (outputScreen) {
        showSlotHighlight(outputScreen);
        return;
      }
    }
  }
  hideSlotHighlight();
}

function onPointerUp(ev) {
  if (dragState !== "DRAGGING") return;

  ev.stopPropagation();
  ev.preventDefault();

  // Hit-test output slots under cursor
  const outputHit = findSlotUnderCursor(ev, "output");

  if (outputHit) {
    // Attempt the connection: output -> input
    // LiteGraph's connect() handles type validation and auto-replaces existing input connections
    const result = outputHit.node.connect(
      outputHit.slotIndex,
      dragNode,
      dragInputIndex
    );

    if (result != null) {
      // Success — the old connection on this input was auto-replaced
      const canvas = app.canvas;
      if (canvas) canvas.setDirty(true, true);

      console.log(
        `[Xavi's Utils] Input Rewire: connected ${outputHit.node.type || outputHit.node.comfyClass}` +
        `.${outputHit.slot.name} -> ${dragNode.type || dragNode.comfyClass}` +
        `.${dragNode.inputs[dragInputIndex].name}`
      );
    } else {
      // Connection failed (type mismatch) — old connection preserved
      console.log("[Xavi's Utils] Input Rewire: incompatible types, connection unchanged.");
    }
  }
  // If no output hit — do nothing; old connection is preserved.

  // Reset
  hideWirePreview();
  hideSlotHighlight();
  dragState = "IDLE";
  dragNode = null;
  dragInputIndex = -1;
  dragInputType = null;
  dragOldLinkId = null;
}

function onPointerCancel(_ev) {
  if (dragState !== "DRAGGING") return;

  hideWirePreview();
  hideSlotHighlight();
  dragState = "IDLE";
  dragNode = null;
  dragInputIndex = -1;
  dragInputType = null;
  dragOldLinkId = null;
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "xavis.input_rewire",

  settings: [
    {
      id: "xavis.inputRewire.Enabled",
      name: "Enable Input Rewire (drag from input)",
      type: "boolean",
      defaultValue: true,
      tooltip:
        "Click and drag from a connected input slot to create a new wire. " +
        "Drop on an output to replace the old connection. " +
        "Drop on empty space to keep the old connection.",
      category: ["Xavi's Utils", "Input Rewire"],
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
        const en = getSetting.call(ctx, "xavis.inputRewire.Enabled");
        if (en != null) enabled = !!en;
      }
    } catch (_) { /* use defaults */ }

    // Create overlay elements
    ensureOverlay();

    // Pointer listeners — capture phase, before LiteGraph
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerCancel, true);

    console.log("[Xavi's Utils] Input Rewire loaded.");
  },
});
