/**
 * tab-search.js
 * Xavi's Utils — Tab to Search at Cursor
 *
 * Press Tab on the graph canvas to open ComfyUI's node search dialog
 * at the current mouse position. If a wire is being dragged, the search
 * filters to compatible node types and auto-connects on selection.
 * Inspired by Houdini, Nuke, and Blender's node editors.
 */

import { app } from "../../scripts/app.js";
import { GRAPH_SELECTOR } from "./utils.js";

// ---------------------------------------------------------------------------
// Settings state
// ---------------------------------------------------------------------------
let enabled = true;

// ---------------------------------------------------------------------------
// Mouse tracking — keydown events don't carry cursor coordinates,
// so we track the last known mouse position passively.
// ---------------------------------------------------------------------------
let lastMouseX = 0;
let lastMouseY = 0;

function onMouseMove(ev) {
  lastMouseX = ev.clientX;
  lastMouseY = ev.clientY;
}

// ---------------------------------------------------------------------------
// Key handler
// ---------------------------------------------------------------------------

function onKeyDown(ev) {
  if (!enabled) return;
  if (ev.key !== "Tab") return;
  if (ev.repeat) return;

  // Don't intercept when typing in a text field
  const tag = ev.target?.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  if (ev.target?.isContentEditable) return;

  // Only trigger if the cursor is currently over the graph canvas
  const target = document.elementFromPoint(lastMouseX, lastMouseY);
  if (!target || !target.closest(GRAPH_SELECTOR)) return;

  const canvas = app.canvas;
  if (!canvas) return;

  // Don't trigger if a ComfyUI dialog/modal is visible
  if (document.querySelector("dialog[open], .comfy-modal.open")) return;

  ev.preventDefault();
  ev.stopPropagation();

  // Build a synthetic mouse event at the tracked cursor position
  const fakeEvent = new MouseEvent("dblclick", {
    clientX: lastMouseX,
    clientY: lastMouseY,
    bubbles: true,
    cancelable: true,
  });

  // Use LiteGraph's search box
  if (typeof canvas.showSearchBox !== "function") return;

  // If a wire is being dragged, pass connection context for type filtering.
  // LiteGraph stores the in-progress connection on the canvas object.
  const options = {};
  if (canvas.connecting_node) {
    options.node_from = canvas.connecting_node;
    options.slot_from = canvas.connecting_output ?? canvas.connecting_slot;

    const slot = canvas.connecting_output;
    if (slot && typeof slot === "object" && slot.type) {
      options.type_filter_in = slot.type;
    }
  }

  canvas.showSearchBox(fakeEvent, options);
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "xavis.tab_search",

  settings: [
    {
      id: "xavis.tabSearch.Enabled",
      name: "Enable Tab to Search",
      type: "boolean",
      defaultValue: true,
      tooltip:
        "Press Tab to open the node search dialog at the cursor position. " +
        "If a wire is being dragged, the search filters to compatible types. " +
        "Inspired by Houdini and Blender.",
      category: ["Xavi's Utils", "Tab Search"],
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
        const en = getSetting.call(ctx, "xavis.tabSearch.Enabled");
        if (en != null) enabled = !!en;
      }
    } catch (_) { /* use defaults */ }

    // Track mouse position passively
    document.addEventListener("mousemove", onMouseMove, { passive: true });

    // Key listener — capture phase to intercept before browser Tab behaviour
    document.addEventListener("keydown", onKeyDown, true);
  },
});
