/**
 * inspector.js
 * Xavi's Utils — Node Inspector (MMB)
 *
 * Responsibilities:
 *  - Register extension + user-facing settings
 *  - Gesture state machine (IDLE -> CANDIDATE -> INSPECTING | PANNING)
 *  - LiteGraph hit testing (node body / input slot / output slot)
 *  - Coordinate between cache, panel, and ComfyUI graph
 */

import { app } from "../../scripts/app.js";
import { inGraph, eventToGraphPos, getCurrentGraph, GRAPH_SELECTOR } from "./utils.js";
import {
  ensureInspectorOverlay,
  positionPanel,
  renderNodePanel,
} from "./inspector-panel.js";
import {
  preloadObjectInfo,
  getNodeSchema,
  getTelemetry,
  getOutputProfile,
  fetchOutputProfile,
  registerCacheListeners,
  getExecCount,
  getLastError,
} from "./inspector-cache.js";

// Load CSS
const link = document.createElement("link");
link.rel = "stylesheet";
link.href = new URL("./inspector-styles.css", import.meta.url).href;
document.head.appendChild(link);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_DRIFT_PX = 100;
const DEFAULT_HOLD_DELAY_MS = 90;
const SLOT_HIT_RADIUS = 14; // px in graph space
const SLOT_HIT_RADIUS_SQ = SLOT_HIT_RADIUS * SLOT_HIT_RADIUS;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let state = "IDLE"; // IDLE | CANDIDATE | INSPECTING | PANNING
let startX = 0;
let startY = 0;
let holdTimer = null;
let didDrag = false;
let panelEl = null;
let currentTarget = null; // HitTarget
let startEvent = null; // stored for deferred openInspector
let pinnedPanelEl = null; // Persistent (pinned) panel element

// Settings (updated by onChange callbacks)
let inspectorEnabled = true;
let bindingMode = "mmb";
let holdDelayMs = DEFAULT_HOLD_DELAY_MS;
let driftPx = DEFAULT_DRIFT_PX;

// ---------------------------------------------------------------------------
// Helpers (inspector-specific, not shared)
// ---------------------------------------------------------------------------

/** Check if the current event satisfies the configured binding. */
function bindingSatisfied(ev) {
  switch (bindingMode) {
    case "mmb":
      return ev.button === 1;
    case "alt+mmb":
      return ev.button === 1 && ev.altKey;
    case "ctrl+click":
      return ev.button === 0 && (ev.ctrlKey || ev.metaKey);
    default:
      return ev.button === 1;
  }
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

/**
 * Determine what lies under the pointer in graph space.
 * Returns a HitTarget object or null.
 *
 * @typedef {Object} HitTarget
 * @property {"node"|"input"|"output"} kind
 * @property {number|string} node_id
 * @property {string} node_type
 * @property {string} [title]
 * @property {number} [input_index]
 * @property {string} [input_name]
 * @property {number|null} [link_id]
 * @property {number} [output_index]
 * @property {string} [output_name]
 * @property {number[]} [links]
 */
function resolveHitTarget(ev) {
  const canvas = app.canvas;
  const graph = getCurrentGraph();
  if (!canvas || !graph) return null;

  const graphPos = eventToGraphPos(ev);
  if (!graphPos) return null;

  const [gx, gy] = graphPos;

  // Find node under cursor
  const node = graph.getNodeOnPos(gx, gy, graph._nodes);
  if (!node) return null;

  // Skip collapsed nodes for slot hit-testing
  const collapsed = node.flags?.collapsed;

  // Check input slots (left side dots)
  if (!collapsed && node.inputs) {
    for (let i = 0; i < node.inputs.length; i++) {
      const pos = node.getConnectionPos(true, i);
      if (pos) {
        const dx = gx - pos[0];
        const dy = gy - pos[1];
        if (dx * dx + dy * dy < SLOT_HIT_RADIUS_SQ) {
          return {
            kind: "input",
            node_id: node.id,
            node_type: node.comfyClass || node.type,
            title: node.title,
            input_index: i,
            input_name: node.inputs[i].name,
            link_id: node.inputs[i].link,
          };
        }
      }
    }
  }

  // Check output slots (right side dots)
  if (!collapsed && node.outputs) {
    for (let i = 0; i < node.outputs.length; i++) {
      const pos = node.getConnectionPos(false, i);
      if (pos) {
        const dx = gx - pos[0];
        const dy = gy - pos[1];
        if (dx * dx + dy * dy < SLOT_HIT_RADIUS_SQ) {
          return {
            kind: "output",
            node_id: node.id,
            node_type: node.comfyClass || node.type,
            title: node.title,
            output_index: i,
            output_name: node.outputs[i].name,
            links: node.outputs[i].links || [],
          };
        }
      }
    }
  }

  // Default: node body
  return {
    kind: "node",
    node_id: node.id,
    node_type: node.comfyClass || node.type,
    title: node.title,
  };
}

// ---------------------------------------------------------------------------
// Inspector open / close
// ---------------------------------------------------------------------------

function openInspector(ev) {
  if (!currentTarget || !panelEl) return;
  const innerEl = panelEl.querySelector(".mmb-ni-panel");
  if (!innerEl) return;

  const nodeType = currentTarget.node_type;
  const schema = getNodeSchema(nodeType);
  const telemetry = getTelemetry(currentTarget.node_id);
  const outputProfile = getOutputProfile(currentTarget.node_id);

  // Gather widget values from the live node
  const graph = getCurrentGraph();
  const liveNode = graph?.getNodeById(currentTarget.node_id) ?? null;
  const widgetValues = {};
  if (liveNode?.widgets) {
    for (const w of liveNode.widgets) {
      if (w.name && w.value !== undefined) {
        widgetValues[w.name] = w.value;
      }
    }
  }

  // Collect upstream node IDs from connected inputs (for input previews)
  const upstreamIds = new Set();
  if (liveNode?.inputs && graph) {
    for (const inp of liveNode.inputs) {
      if (inp.link != null) {
        const link = graph.links?.[inp.link] || graph._links?.get?.(inp.link);
        if (link) upstreamIds.add(String(link.origin_id));
      }
    }
  }

  // Build inputProfiles from already-cached upstream output profiles
  const inputProfiles = new Map();
  for (const uid of upstreamIds) {
    const cached = getOutputProfile(uid);
    if (cached) inputProfiles.set(uid, cached);
  }

  // Build options (transient panel — not pinned)
  const options = {
    isPinned: false,
    execCount: getExecCount(currentTarget.node_id),
    lastError: getLastError(currentTarget.node_id),
  };

  // Render immediately with whatever data we have
  renderNodePanel(innerEl, currentTarget, schema, telemetry, widgetValues, liveNode, outputProfile, inputProfiles, options);
  positionPanel(panelEl, ev.clientX, ev.clientY);

  // Async fetch: own output profile + any missing upstream profiles
  const nodeId = currentTarget.node_id;
  const target = currentTarget;

  const fetchPromises = [];
  if (!outputProfile && telemetry) {
    fetchPromises.push(fetchOutputProfile(nodeId));
  }
  const missingUpstream = [...upstreamIds].filter(id => !inputProfiles.has(id));
  for (const uid of missingUpstream) {
    fetchPromises.push(fetchOutputProfile(uid));
  }

  if (fetchPromises.length > 0) {
    Promise.all(fetchPromises).then(() => {
      if (state !== "INSPECTING" || currentTarget !== target) return;

      // Rebuild data from caches
      const freshOutputProfile = getOutputProfile(nodeId);
      const freshTelemetry = getTelemetry(nodeId);
      const freshInputProfiles = new Map();
      for (const uid of upstreamIds) {
        const p = getOutputProfile(uid);
        if (p) freshInputProfiles.set(uid, p);
      }

      const freshOptions = {
        isPinned: false,
        execCount: getExecCount(nodeId),
        lastError: getLastError(nodeId),
      };
      renderNodePanel(innerEl, target, schema, freshTelemetry, widgetValues, liveNode, freshOutputProfile, freshInputProfiles, freshOptions);
      positionPanel(panelEl, ev.clientX, ev.clientY);
    });
  }
}

function closeInspector() {
  if (!panelEl) return;
  panelEl.style.transform = "translate3d(-9999px, -9999px, 0)";
  const innerEl = panelEl.querySelector(".mmb-ni-panel");
  if (innerEl) innerEl.innerHTML = "";
  currentTarget = null;
}

// ---------------------------------------------------------------------------
// Pinned (persistent) panel — Ctrl+MMB
// ---------------------------------------------------------------------------

function openPinnedPanel(ev) {
  const target = resolveHitTarget(ev);
  if (!target) return;

  // Remove existing pinned panel if any
  closePinnedPanel();

  // Create pinned container
  const container = document.createElement("div");
  container.className = "mmb-ni-pinned";

  // Close button
  const closeBtn = document.createElement("button");
  closeBtn.className = "mmb-ni-close-btn";
  closeBtn.textContent = "\u00D7"; // ×
  closeBtn.title = "Close (Esc)";
  closeBtn.addEventListener("click", () => closePinnedPanel());
  container.appendChild(closeBtn);

  // Inner panel (reuses same class for inherited styles)
  const innerEl = document.createElement("div");
  innerEl.className = "mmb-ni-panel";
  container.appendChild(innerEl);

  document.body.appendChild(container);
  pinnedPanelEl = container;

  // Gather data — same logic as openInspector()
  const graph = getCurrentGraph();
  const schema = getNodeSchema(target.node_type);
  const telemetry = getTelemetry(target.node_id);
  const outputProfile = getOutputProfile(target.node_id);
  const liveNode = graph?.getNodeById(target.node_id) ?? null;

  const widgetValues = {};
  if (liveNode?.widgets) {
    for (const w of liveNode.widgets) {
      if (w.name && w.value !== undefined) widgetValues[w.name] = w.value;
    }
  }

  // Collect upstream IDs for input previews
  const upstreamIds = new Set();
  if (liveNode?.inputs && graph) {
    for (const inp of liveNode.inputs) {
      if (inp.link != null) {
        const link = graph.links?.[inp.link] || graph._links?.get?.(inp.link);
        if (link) upstreamIds.add(String(link.origin_id));
      }
    }
  }
  const inputProfiles = new Map();
  for (const uid of upstreamIds) {
    const cached = getOutputProfile(uid);
    if (cached) inputProfiles.set(uid, cached);
  }

  // Build options (pinned panel)
  const options = {
    isPinned: true,
    execCount: getExecCount(target.node_id),
    lastError: getLastError(target.node_id),
  };

  // Render immediately
  renderNodePanel(innerEl, target, schema, telemetry, widgetValues, liveNode, outputProfile, inputProfiles, options);
  positionPanel(container, ev.clientX, ev.clientY);

  // Async-fetch missing profiles and re-render
  const nodeId = target.node_id;
  const fetchPromises = [];
  if (!outputProfile && telemetry) fetchPromises.push(fetchOutputProfile(nodeId));
  const missingUpstream = [...upstreamIds].filter(id => !inputProfiles.has(id));
  for (const uid of missingUpstream) fetchPromises.push(fetchOutputProfile(uid));

  if (fetchPromises.length > 0) {
    Promise.all(fetchPromises).then(() => {
      if (!pinnedPanelEl || pinnedPanelEl !== container) return;

      const freshOutputProfile = getOutputProfile(nodeId);
      const freshTelemetry = getTelemetry(nodeId);
      const freshInputProfiles = new Map();
      for (const uid of upstreamIds) {
        const p = getOutputProfile(uid);
        if (p) freshInputProfiles.set(uid, p);
      }

      const freshOptions = {
        isPinned: true,
        execCount: getExecCount(nodeId),
        lastError: getLastError(nodeId),
      };
      renderNodePanel(innerEl, target, schema, freshTelemetry, widgetValues, liveNode, freshOutputProfile, freshInputProfiles, freshOptions);
      positionPanel(container, ev.clientX, ev.clientY);
    });
  }
}

function closePinnedPanel() {
  if (!pinnedPanelEl) return;
  pinnedPanelEl.remove();
  pinnedPanelEl = null;
}

// ---------------------------------------------------------------------------
// Gesture state machine
// ---------------------------------------------------------------------------

function onPointerDown(ev) {
  if (!inspectorEnabled) return;

  // Ctrl+MMB = pin panel (always available, regardless of binding setting)
  if (ev.button === 1 && (ev.ctrlKey || ev.metaKey) && inGraph(ev)) {
    openPinnedPanel(ev);
    ev.preventDefault();
    return;
  }

  if (state !== "IDLE") return;
  if (!inGraph(ev)) return;
  if (!bindingSatisfied(ev)) return;

  state = "CANDIDATE";
  didDrag = false;
  startX = ev.clientX;
  startY = ev.clientY;
  startEvent = ev;

  const delay = holdDelayMs;
  holdTimer = setTimeout(() => {
    if (state !== "CANDIDATE") return;

    // Resolve what is under cursor
    currentTarget = resolveHitTarget(startEvent);
    if (!currentTarget) {
      state = "IDLE";
      startEvent = null;
      return;
    }

    state = "INSPECTING";
    openInspector(startEvent);
    startEvent = null;
  }, delay);

  // NOTE: Do NOT preventDefault here -- that would break LiteGraph's
  // native canvas panning. The auxclick handler below suppresses the
  // Linux paste and reroute-node-creation side-effects on mouseup.
}

function onPointerMove(ev) {
  if (state === "IDLE") return;

  const dx = ev.clientX - startX;
  const dy = ev.clientY - startY;
  const d2 = dx * dx + dy * dy;
  const threshold = driftPx * driftPx;

  if (!didDrag && d2 > threshold) {
    didDrag = true;
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (state === "INSPECTING") closeInspector();
    state = "PANNING";
    startEvent = null;
  }
}

function onPointerUp(ev) {
  if (holdTimer) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
  if (state === "INSPECTING") closeInspector();
  state = "IDLE";
  currentTarget = null;
  startEvent = null;
}

function onAuxClick(ev) {
  if (!inGraph(ev)) return;
  if (ev.button !== 1) return;

  // Suppress browser auxclick default (Linux paste, reroute creation)
  // when we were handling an inspector gesture
  if (didDrag || state !== "IDLE") {
    ev.preventDefault();
    ev.stopPropagation();
  }
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "xavis.node_inspector",

  settings: [
    {
      id: "xavis.inspector.Enabled",
      name: "Enable Node Inspector",
      type: "boolean",
      defaultValue: true,
      tooltip: "Hold middle mouse button to inspect nodes, slots, and connections.",
      category: ["Xavi's Utils", "Node Inspector"],
      onChange: (v) => {
        inspectorEnabled = !!v;
      },
    },
    {
      id: "xavis.inspector.Binding",
      name: "Inspector activation binding",
      type: "combo",
      defaultValue: "mmb",
      options: ["mmb", "alt+mmb", "ctrl+click"],
      tooltip:
        "How to trigger the inspector. 'mmb' = hold middle mouse. " +
        "'alt+mmb' = hold Alt + middle mouse. " +
        "'ctrl+click' = Ctrl + left click.",
      category: ["Xavi's Utils", "Node Inspector"],
      onChange: (v) => {
        bindingMode = v;
      },
    },
    {
      id: "xavis.inspector.HoldDelay",
      name: "Hold delay (ms)",
      type: "number",
      defaultValue: DEFAULT_HOLD_DELAY_MS,
      tooltip: "Milliseconds to hold before the inspector panel opens.",
      category: ["Xavi's Utils", "Node Inspector"],
      attrs: { min: 0, max: 500, step: 10 },
      onChange: (v) => {
        holdDelayMs = Number(v) || DEFAULT_HOLD_DELAY_MS;
      },
    },
    {
      id: "xavis.inspector.DriftThreshold",
      name: "Drift threshold (px)",
      type: "number",
      defaultValue: DEFAULT_DRIFT_PX,
      tooltip:
        "Maximum cursor movement (pixels) before the gesture is treated " +
        "as a pan instead of an inspection.",
      category: ["Xavi's Utils", "Node Inspector"],
      attrs: { min: 1, max: 200, step: 5 },
      onChange: (v) => {
        driftPx = Number(v) || DEFAULT_DRIFT_PX;
      },
    },
  ],

  async setup() {
    // 1. Create the overlay DOM
    panelEl = ensureInspectorOverlay();

    // 2. Prefetch /object_info (node definitions)
    preloadObjectInfo();

    // 3. Register WebSocket listeners for telemetry
    registerCacheListeners();

    // 4. Read initial setting values
    try {
      const getSetting = app.extensionManager?.setting?.get
        ?? app.ui?.settings?.getSettingValue;
      if (getSetting) {
        const ctx = app.extensionManager?.setting ?? app.ui?.settings;

        const en = getSetting.call(ctx, "xavis.inspector.Enabled");
        if (en != null) inspectorEnabled = !!en;

        const b = getSetting.call(ctx, "xavis.inspector.Binding");
        if (b) bindingMode = b;

        const d = getSetting.call(ctx, "xavis.inspector.HoldDelay");
        if (d != null) holdDelayMs = Number(d) || DEFAULT_HOLD_DELAY_MS;

        const t = getSetting.call(ctx, "xavis.inspector.DriftThreshold");
        if (t != null) driftPx = Number(t) || DEFAULT_DRIFT_PX;
      }
    } catch (_) {
      // Settings API may not be available; use defaults
    }

    // 5. Attach gesture listeners in capture phase
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerUp, true);

    // 6. Suppress Linux auxclick paste / reroute creation
    document.addEventListener("auxclick", onAuxClick, true);

    // 7. Escape key closes pinned panel
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && pinnedPanelEl) {
        closePinnedPanel();
      }
    });
  },
});
