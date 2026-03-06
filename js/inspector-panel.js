/**
 * inspector-panel.js
 * DOM overlay creation, content rendering, and viewport positioning.
 */

// ---------------------------------------------------------------------------
// Type explanation map for common ComfyUI data types
// ---------------------------------------------------------------------------
const TYPE_EXPLANATIONS = {
  IMAGE:        "Tensor [B, H, W, C]  float32  RGB",
  LATENT:       "Dict { samples: Tensor [B, C, H, W] }",
  MASK:         "Tensor [B, H, W]  float32  [0\u20261]",
  CONDITIONING: "List [ [Tensor, Dict] ]",
  MODEL:        "Model patcher object",
  CLIP:         "CLIP model object",
  VAE:          "VAE model object",
  STRING:       "String",
  INT:          "Integer",
  FLOAT:        "Float",
  BOOLEAN:      "Boolean",
  AUDIO:        "Dict { waveform: [B,C,T], sample_rate }",
  COMBO:        "Combo selection",
};

// ---------------------------------------------------------------------------
// Wire color lookup – matches IO names to the canvas wire palette
// ---------------------------------------------------------------------------
function getWireColor(typeName) {
  try {
    return window.app?.canvas?.default_connection_color_byType?.[typeName] || null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Overlay lifecycle
// ---------------------------------------------------------------------------

/**
 * Create (or return existing) singleton overlay root appended to document.body.
 * @returns {HTMLElement}
 */
export function ensureInspectorOverlay() {
  let root = document.getElementById("mmb-node-inspector");
  if (root) return root;

  root = document.createElement("div");
  root.id = "mmb-node-inspector";

  const inner = document.createElement("div");
  inner.className = "mmb-ni-panel";
  root.appendChild(inner);

  document.body.appendChild(root);
  return root;
}

// ---------------------------------------------------------------------------
// Positioning
// ---------------------------------------------------------------------------

/**
 * Position the panel near the cursor, clamped to viewport edges.
 * Uses translate3d for GPU-composited movement (no layout thrash).
 */
export function positionPanel(panelEl, clientX, clientY) {
  const PAD = 14;
  const inner = panelEl.firstElementChild;
  if (!inner) return;

  const rect = inner.getBoundingClientRect();
  const pw = rect.width || 260;
  const ph = rect.height || 120;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let x = clientX + PAD;
  let y = clientY + PAD;

  if (x + pw > vw - 8) x = clientX - PAD - pw;
  if (y + ph > vh - 8) y = clientY - PAD - ph;
  if (x < 4) x = 4;
  if (y < 4) y = 4;

  panelEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
function el(tag, className, textContent) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (textContent !== undefined) e.textContent = textContent;
  return e;
}

function sep() {
  return el("hr", "mmb-ni-sep");
}

function badge(text, modifier) {
  return el("span", `mmb-ni-badge mmb-ni-badge--${modifier}`, text);
}

function formatBytes(bytes) {
  if (bytes == null) return null;
  const abs = Math.abs(bytes);
  const sign = bytes >= 0 ? "+" : "\u2212";
  if (abs < 1024) return `${sign}${abs} B`;
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KB`;
  if (abs < 1024 * 1024 * 1024) return `${sign}${(abs / (1024 * 1024)).toFixed(1)} MB`;
  return `${sign}${(abs / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatBytesAbsolute(bytes) {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "\u2026" : str;
}

/**
 * Returns an inline SVG icon of stacked frames (two offset overlapping squares)
 * to indicate an animated image sequence (batch > 1).
 */
function sequenceIcon() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.classList.add("mmb-ni-sequence-icon");

  // Back frame (offset top-left)
  const r1 = document.createElementNS(NS, "rect");
  r1.setAttribute("x", "0.5"); r1.setAttribute("y", "0.5");
  r1.setAttribute("width", "11"); r1.setAttribute("height", "11");
  r1.setAttribute("rx", "1.5");
  r1.setAttribute("fill", "none");
  r1.setAttribute("stroke", "currentColor");
  r1.setAttribute("stroke-width", "1.2");
  r1.setAttribute("opacity", "0.5");
  svg.appendChild(r1);

  // Front frame (offset bottom-right)
  const r2 = document.createElementNS(NS, "rect");
  r2.setAttribute("x", "4.5"); r2.setAttribute("y", "4.5");
  r2.setAttribute("width", "11"); r2.setAttribute("height", "11");
  r2.setAttribute("rx", "1.5");
  r2.setAttribute("fill", "rgba(18,18,22,0.6)");
  r2.setAttribute("stroke", "currentColor");
  r2.setAttribute("stroke-width", "1.2");
  svg.appendChild(r2);

  return svg;
}

/**
 * Creates a badge overlay for a thumbnail container showing frame count.
 * @param {number} batch - batch/frame count (only shown when > 1)
 */
function sequenceBadge(batch) {
  const badge = el("div", "mmb-ni-sequence-badge");
  badge.appendChild(sequenceIcon());
  badge.appendChild(document.createTextNode(` ${batch}`));
  return badge;
}

/**
 * Build a short " • dtype (device)" suffix from a profile object.
 * Returns "" if no dtype/device info.
 */
function _dtypeDeviceSuffix(profile) {
  if (!profile) return "";
  const parts = [];
  if (profile.dtype) parts.push(profile.dtype.replace("torch.", ""));
  if (profile.device && profile.device !== "cpu") parts.push(profile.device);
  return parts.length > 0 ? ` \u2022 ${parts.join(" ")}` : "";
}

function getTypeExplanation(typeName) {
  if (!typeName) return null;
  const key = String(typeName).toUpperCase();
  return TYPE_EXPLANATIONS[key] || null;
}

function formatCookTime(ms) {
  if (ms == null) return null;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// ---------------------------------------------------------------------------
// Content rendering
// ---------------------------------------------------------------------------

/**
 * Render inspection content into the panel's inner div.
 * @param {HTMLElement} innerEl - the .mmb-ni-panel div
 * @param {object} hitTarget  - { kind, node_id, node_type, title, ... }
 * @param {object|null} schema - /object_info entry for node_type
 * @param {object|null} telemetry - { dt_ms, vram_delta, ram_delta, cached, last_cook_ms }
 * @param {object} widgetValues - { widgetName: value, ... }
 * @param {object|null} liveNode - the live LiteGraph node
 * @param {object|null} outputProfile - from /mmb_inspector/outputs/{id}
 * @param {Map|null} inputProfiles - Map of upstreamNodeId → outputProfile for connected inputs
 */
export function renderNodePanel(innerEl, hitTarget, schema, telemetry, widgetValues, liveNode, outputProfile, inputProfiles, options = {}) {
  innerEl.innerHTML = "";

  if (hitTarget.kind === "node") {
    renderNodeBody(innerEl, hitTarget, schema, telemetry, widgetValues, liveNode, outputProfile, inputProfiles, options);
  } else if (hitTarget.kind === "input") {
    renderInputSlot(innerEl, hitTarget, schema, telemetry, liveNode, outputProfile, inputProfiles);
  } else if (hitTarget.kind === "output") {
    renderOutputSlot(innerEl, hitTarget, schema, telemetry, liveNode, outputProfile);
  }
}

// ---------------------------------------------------------------------------
// Node body
// ---------------------------------------------------------------------------
function renderNodeBody(root, target, schema, telemetry, widgetValues, liveNode, outputProfile, inputProfiles, options = {}) {
  // Header: title + #id + class
  const header = el("div", "mmb-ni-header");
  header.appendChild(el("span", "mmb-ni-title", target.title || target.node_type));
  header.appendChild(el("span", "mmb-ni-id", `#${target.node_id}`));
  if (target.node_type && target.node_type !== target.title) {
    header.appendChild(el("span", "mmb-ni-class", target.node_type));
  }
  root.appendChild(header);

  // Provenance
  if (schema) {
    const prov = el("div", "mmb-ni-provenance");
    if (schema.python_module) prov.appendChild(el("span", null, schema.python_module));
    if (schema.category) prov.appendChild(el("span", null, schema.category));
    if (prov.childElementCount > 0) root.appendChild(prov);
  }

  // Badges
  const badges = el("div", "mmb-ni-badges");
  if (schema?.deprecated) badges.appendChild(badge("Deprecated", "deprecated"));
  if (schema?.experimental) badges.appendChild(badge("Experimental", "experimental"));
  if (schema?.output_node) badges.appendChild(badge("Output", "output"));
  if (telemetry?.cached) badges.appendChild(badge("Cached", "cached"));
  // LiteGraph modes: 0=ALWAYS (normal), 2=NEVER (bypassed), 4=MUTED
  if (liveNode?.mode === 2) badges.appendChild(badge("Bypassed", "bypassed"));
  if (liveNode?.mode === 4) badges.appendChild(badge("Muted", "muted"));
  if (badges.childElementCount > 0) root.appendChild(badges);

  // Validation warnings (disconnected required inputs)
  renderValidationWarnings(root, schema, liveNode);

  // Description
  if (schema?.description) {
    root.appendChild(sep());
    root.appendChild(el("div", "mmb-ni-description", truncate(schema.description, 300)));
  }

  // IO summary
  renderIOSection(root, schema, liveNode, widgetValues, outputProfile);

  // Input previews (thumbnails from upstream nodes)
  renderInputPreviews(root, liveNode, inputProfiles);

  // Output previews (thumbnails + resolution info)
  if (outputProfile) {
    renderOutputPreviews(root, outputProfile);
  }

  // Last error (if any)
  renderErrorSection(root, options.lastError);

  // Execution stats
  root.appendChild(sep());
  renderExecStats(root, telemetry, outputProfile, options);

  // Action buttons (pinned panel only)
  renderActions(root, target, liveNode, options);
}

// ---------------------------------------------------------------------------
// IO section
// ---------------------------------------------------------------------------
function renderIOSection(root, schema, liveNode, widgetValues, outputProfile) {
  if (!schema) return;

  const inputDefs = schema.input || {};
  const requiredInputs = inputDefs.required || {};
  const optionalInputs = inputDefs.optional || {};
  const allInputs = { ...requiredInputs, ...optionalInputs };
  const outputNames = schema.output_name || schema.output || [];
  const outputTypes = schema.output || [];

  const hasInputs = Object.keys(allInputs).length > 0;
  const hasOutputs = outputTypes.length > 0;

  if (!hasInputs && !hasOutputs) return;
  root.appendChild(sep());

  // Inputs — ordered to match ComfyUI node visual layout:
  // 1. Slot inputs (wired connections) in their visual order from liveNode.inputs
  // 2. Widget inputs (parameters) in their widget order from liveNode.widgets
  if (hasInputs) {
    root.appendChild(el("div", "mmb-ni-section-label", "Inputs"));
    const table = el("table", "mmb-ni-io-table");
    const tbody = document.createElement("tbody");

    // Build ordered input list: slots first, then widgets
    const orderedNames = [];
    const seen = new Set();

    // Slot inputs — in visual order (top to bottom on the node)
    if (liveNode?.inputs) {
      for (const inp of liveNode.inputs) {
        if (inp.name && allInputs[inp.name] !== undefined) {
          orderedNames.push(inp.name);
          seen.add(inp.name);
        }
      }
    }

    // Widget inputs — in widget order (controls on the node body)
    if (liveNode?.widgets) {
      for (const w of liveNode.widgets) {
        if (w.name && !seen.has(w.name) && allInputs[w.name] !== undefined) {
          orderedNames.push(w.name);
          seen.add(w.name);
        }
      }
    }

    // Any remaining schema inputs not found on the live node (fallback)
    for (const name of Object.keys(allInputs)) {
      if (!seen.has(name)) {
        orderedNames.push(name);
      }
    }

    for (const name of orderedNames) {
      const spec = allInputs[name];
      const typeName = Array.isArray(spec) ? spec[0] : spec;
      const displayType = Array.isArray(typeName) ? "COMBO" : String(typeName);

      let connected = false;
      let connectedValue = undefined;

      if (liveNode?.inputs) {
        const inp = liveNode.inputs.find(i => i.name === name);
        if (inp && inp.link != null) {
          connected = true;
          connectedValue = getUpstreamPrimitiveValue(liveNode, inp, name);
        }
      }

      const tr = document.createElement("tr");

      const wireColor = getWireColor(displayType);

      const tdName = el("td", "mmb-ni-io-name");
      const dot = el("span", `mmb-ni-io-dot mmb-ni-io-dot--${connected ? "connected" : "disconnected"}`);
      if (wireColor && connected) dot.style.background = wireColor;
      tdName.appendChild(dot);
      const nameSpan = document.createElement("span");
      nameSpan.textContent = name;
      if (wireColor) nameSpan.style.color = wireColor;
      tdName.appendChild(nameSpan);
      tr.appendChild(tdName);

      const tdType = el("td", "mmb-ni-io-type", displayType);
      if (wireColor) tdType.style.color = wireColor;
      tr.appendChild(tdType);

      const tdVal = el("td", "mmb-ni-io-value");
      if (connected && connectedValue !== undefined) {
        tdVal.textContent = truncate(String(connectedValue), 40);
        tdVal.title = String(connectedValue);
      } else if (!connected && widgetValues && widgetValues[name] !== undefined) {
        tdVal.textContent = truncate(String(widgetValues[name]), 40);
      }
      tr.appendChild(tdVal);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    root.appendChild(table);
  }

  // Outputs
  if (hasOutputs) {
    root.appendChild(el("div", "mmb-ni-section-label", "Outputs"));
    const table = el("table", "mmb-ni-io-table");
    const tbody = document.createElement("tbody");

    for (let i = 0; i < outputTypes.length; i++) {
      const typeName = String(outputTypes[i]);
      const name = (Array.isArray(outputNames) && outputNames[i]) ? outputNames[i] : typeName;

      let linkCount = 0;
      if (liveNode?.outputs?.[i]?.links) {
        linkCount = liveNode.outputs[i].links.length;
      }

      const tr = document.createElement("tr");

      const wireColor = getWireColor(typeName);

      const tdName = el("td", "mmb-ni-io-name");
      const dot = el("span", `mmb-ni-io-dot mmb-ni-io-dot--${linkCount > 0 ? "connected" : "disconnected"}`);
      if (wireColor && linkCount > 0) dot.style.background = wireColor;
      tdName.appendChild(dot);
      const nameSpan = document.createElement("span");
      nameSpan.textContent = name;
      if (wireColor) nameSpan.style.color = wireColor;
      tdName.appendChild(nameSpan);
      tr.appendChild(tdName);

      const tdType = el("td", "mmb-ni-io-type", typeName);
      if (wireColor) tdType.style.color = wireColor;
      tr.appendChild(tdType);

      const tdInfo = el("td", "mmb-ni-io-value");
      const outProfile = outputProfile?.outputs?.[i];
      if (outProfile) {
        const summary = getOutputSummary(outProfile);
        if (summary) {
          tdInfo.textContent = summary;
          tdInfo.title = summary;
        }
      } else if (linkCount > 0) {
        tdInfo.textContent = `\u2192 ${linkCount} link${linkCount !== 1 ? "s" : ""}`;
      }
      tr.appendChild(tdInfo);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    root.appendChild(table);
  }
}

// ---------------------------------------------------------------------------
// Output summary string for IO table
// ---------------------------------------------------------------------------
function getOutputSummary(profile) {
  if (!profile) return null;
  const kind = profile.kind;

  const batch = profile.batch || 1;
  if (kind === "IMAGE") return `${profile.width}\u00D7${profile.height}${batch > 1 ? ` \u00D7${batch}f` : ""}`;
  if (kind === "MASK") return `${profile.width}\u00D7${profile.height}${batch > 1 ? ` \u00D7${batch}f` : ""}`;
  if (kind === "LATENT" || kind === "LATENT_SAMPLES") {
    const w = profile.approx_width || "?";
    const h = profile.approx_height || "?";
    return `${w}\u00D7${h} latent`;
  }
  if (kind === "AUDIO") {
    const dur = profile.duration_s != null ? `${profile.duration_s}s` : "?";
    return `${dur} ${profile.sample_rate || ""}Hz`.trim();
  }
  if (kind === "NUMBER") return String(profile.value);
  if (kind === "STRING") return truncate(profile.value || "", 30);
  if (kind === "BOOLEAN") return String(profile.value);
  return null;
}

// ---------------------------------------------------------------------------
// Upstream primitive value lookup
// ---------------------------------------------------------------------------
function getUpstreamPrimitiveValue(node, input, inputName) {
  const graph = window.app?.graph;
  if (!graph || input.link == null) return undefined;

  const link = graph.links?.[input.link] || graph._links?.get?.(input.link);
  if (!link) return undefined;

  const srcNode = graph.getNodeById(link.origin_id);
  if (!srcNode) return undefined;

  if (srcNode.widgets && srcNode.widgets.length > 0) {
    for (const w of srcNode.widgets) {
      if (w.value !== undefined) {
        const val = w.value;
        if (typeof val === "number" || typeof val === "string" || typeof val === "boolean") {
          return val;
        }
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Input previews (thumbnails from upstream nodes)
// ---------------------------------------------------------------------------
function renderInputPreviews(root, liveNode, inputProfiles) {
  if (!liveNode?.inputs || !inputProfiles || inputProfiles.size === 0) return;

  const graph = window.app?.graph;
  if (!graph) return;

  // Collect visual input entries: { name, slotProfile, thumbB64 }
  const entries = [];
  for (const inp of liveNode.inputs) {
    if (inp.link == null) continue;
    const link = graph.links?.[inp.link] || graph._links?.get?.(inp.link);
    if (!link) continue;

    const upId = String(link.origin_id);
    const upSlot = link.origin_slot;
    const upProfile = inputProfiles.get(upId);
    if (!upProfile?.outputs?.[upSlot]) continue;

    const slotProfile = upProfile.outputs[upSlot];
    const kind = slotProfile.kind;
    if (kind !== "IMAGE" && kind !== "MASK" && kind !== "LATENT" && kind !== "LATENT_SAMPLES") continue;

    const thumbB64 = upProfile.thumbnails?.[String(upSlot)] || null;
    entries.push({ name: inp.name, slotProfile, thumbB64, kind });
  }

  if (entries.length === 0) return;

  root.appendChild(sep());
  root.appendChild(el("div", "mmb-ni-section-label", "Input Data"));

  for (const entry of entries) {
    const { name, slotProfile: out, thumbB64, kind } = entry;
    const batch = out.batch || 1;
    const isSeq = batch > 1;

    // Resolution / dimension info
    const dtypeSuffix = _dtypeDeviceSuffix(out);

    if (kind === "IMAGE") {
      const info = el("div", "mmb-ni-output-info");
      if (isSeq) info.appendChild(sequenceIcon());
      let text = `${name}: ${out.width}\u00D7${out.height} \u00D7 ${batch} frame${batch !== 1 ? "s" : ""} \u2022 ${out.channels || 3}ch`;
      if (out.bytes) text += ` \u2022 ${formatBytesAbsolute(out.bytes)}`;
      text += dtypeSuffix;
      info.appendChild(document.createTextNode(text));
      root.appendChild(info);
    } else if (kind === "MASK") {
      const info = el("div", "mmb-ni-output-info");
      if (isSeq) info.appendChild(sequenceIcon());
      let text = `${name}: ${out.width}\u00D7${out.height} \u00D7 ${batch} frame${batch !== 1 ? "s" : ""}`;
      if (out.bytes) text += ` \u2022 ${formatBytesAbsolute(out.bytes)}`;
      text += dtypeSuffix;
      info.appendChild(document.createTextNode(text));
      root.appendChild(info);
    } else if (kind === "LATENT" || kind === "LATENT_SAMPLES") {
      const info = el("div", "mmb-ni-output-info");
      if (isSeq) info.appendChild(sequenceIcon());
      let text = `${name}: ${out.latent_width || "?"}\u00D7${out.latent_height || "?"} (${out.approx_width || "?"}\u00D7${out.approx_height || "?"} px) \u00D7 ${batch} frame${batch !== 1 ? "s" : ""}`;
      if (out.bytes) text += ` \u2022 ${formatBytesAbsolute(out.bytes)}`;
      text += dtypeSuffix;
      info.appendChild(document.createTextNode(text));
      root.appendChild(info);
    }

    // Thumbnail
    if (thumbB64) {
      const thumbContainer = el("div", "mmb-ni-thumb-container");
      const img = document.createElement("img");
      img.src = `data:image/jpeg;base64,${thumbB64}`;
      img.className = "mmb-ni-thumb";
      img.alt = `${name} input preview`;
      thumbContainer.appendChild(img);
      if (isSeq && (kind === "IMAGE" || kind === "MASK")) {
        thumbContainer.appendChild(sequenceBadge(batch));
      }
      root.appendChild(thumbContainer);
    }
  }
}

// ---------------------------------------------------------------------------
// Output previews (thumbnails + resolution details)
// ---------------------------------------------------------------------------
function renderOutputPreviews(root, outputProfile) {
  if (!outputProfile?.outputs?.length) return;

  const hasVisualData = outputProfile.outputs.some(o =>
    o.kind === "IMAGE" || o.kind === "MASK" || o.kind === "LATENT" || o.kind === "LATENT_SAMPLES"
  );
  const hasThumbs = outputProfile.thumbnails && Object.keys(outputProfile.thumbnails).length > 0;

  if (!hasVisualData && !hasThumbs) return;

  root.appendChild(sep());
  root.appendChild(el("div", "mmb-ni-section-label", "Output Data"));

  for (let i = 0; i < outputProfile.outputs.length; i++) {
    const out = outputProfile.outputs[i];
    const kind = out.kind;

    const batch = out.batch || 1;
    const isSeq = batch > 1;

    // Build dtype/device suffix for tensor outputs
    const dtypeSuffix = _dtypeDeviceSuffix(out);

    if (kind === "IMAGE") {
      const info = el("div", "mmb-ni-output-info");
      if (isSeq) info.appendChild(sequenceIcon());
      let text = `Image: ${out.width}\u00D7${out.height} \u00D7 ${batch} frame${batch !== 1 ? "s" : ""} \u2022 ${out.channels || 3}ch`;
      if (out.bytes) text += ` \u2022 ${formatBytesAbsolute(out.bytes)}`;
      text += dtypeSuffix;
      info.appendChild(document.createTextNode(text));
      root.appendChild(info);
    } else if (kind === "MASK") {
      const info = el("div", "mmb-ni-output-info");
      if (isSeq) info.appendChild(sequenceIcon());
      let text = `Mask: ${out.width}\u00D7${out.height} \u00D7 ${batch} frame${batch !== 1 ? "s" : ""}`;
      if (out.bytes) text += ` \u2022 ${formatBytesAbsolute(out.bytes)}`;
      text += dtypeSuffix;
      info.appendChild(document.createTextNode(text));
      root.appendChild(info);
    } else if (kind === "LATENT" || kind === "LATENT_SAMPLES") {
      const info = el("div", "mmb-ni-output-info");
      if (isSeq) info.appendChild(sequenceIcon());
      let text = `Latent: ${out.latent_width || "?"}\u00D7${out.latent_height || "?"} (${out.approx_width || "?"}\u00D7${out.approx_height || "?"} px) \u00D7 ${batch} frame${batch !== 1 ? "s" : ""}`;
      if (out.bytes) text += ` \u2022 ${formatBytesAbsolute(out.bytes)}`;
      text += dtypeSuffix;
      info.appendChild(document.createTextNode(text));
      root.appendChild(info);
    } else if (kind === "AUDIO") {
      root.appendChild(el("div", "mmb-ni-output-info",
        `Audio: ${out.duration_s || "?"}s @ ${out.sample_rate || "?"}Hz`));
    }

    const thumbB64 = outputProfile.thumbnails?.[String(i)];
    if (thumbB64) {
      const thumbContainer = el("div", "mmb-ni-thumb-container");
      const img = document.createElement("img");
      img.src = `data:image/jpeg;base64,${thumbB64}`;
      img.className = "mmb-ni-thumb";
      img.alt = `${kind} preview`;
      thumbContainer.appendChild(img);
      if (isSeq && (kind === "IMAGE" || kind === "MASK")) {
        thumbContainer.appendChild(sequenceBadge(batch));
      }
      root.appendChild(thumbContainer);
    }
  }
}

// ---------------------------------------------------------------------------
// Execution stats
// ---------------------------------------------------------------------------
function renderExecStats(root, telemetry, outputProfile, options = {}) {
  root.appendChild(el("div", "mmb-ni-section-label", "Execution"));
  const exec = el("div", "mmb-ni-exec");

  // Helper: append exec count then flush exec div to root
  function _appendExecCount() {
    if (options.execCount > 0) {
      const runsStat = el("span", "mmb-ni-stat");
      runsStat.textContent = "Runs: ";
      runsStat.appendChild(el("span", "mmb-ni-stat-value", String(options.execCount)));
      exec.appendChild(runsStat);
    }
    root.appendChild(exec);
  }

  if (!telemetry) {
    exec.appendChild(el("span", "mmb-ni-stat mmb-ni-stat--muted", "Not yet executed"));
    _appendExecCount();
    return;
  }

  if (telemetry.cached) {
    const lastCook = telemetry.last_cook_ms;
    if (lastCook != null) {
      const cookStat = el("span", "mmb-ni-stat");
      cookStat.textContent = "Last cook: ";
      cookStat.appendChild(el("span", "mmb-ni-stat-value", formatCookTime(lastCook)));
      exec.appendChild(cookStat);
      exec.appendChild(el("span", "mmb-ni-stat mmb-ni-stat--muted", "(cached)"));
    } else {
      exec.appendChild(el("span", "mmb-ni-stat mmb-ni-stat--muted", "Cached (no re-execution)"));
    }

    const cacheBytes = outputProfile?.cache_bytes;
    if (cacheBytes != null && cacheBytes > 0) {
      const cacheStat = el("span", "mmb-ni-stat");
      cacheStat.textContent = "Cache: ";
      cacheStat.appendChild(el("span", "mmb-ni-stat-value", formatBytesAbsolute(cacheBytes)));
      exec.appendChild(cacheStat);
    }

    _appendExecCount();
    return;
  }

  // Cook time
  const cookStat = el("span", "mmb-ni-stat");
  cookStat.textContent = "Cook: ";
  cookStat.appendChild(el("span", "mmb-ni-stat-value", formatCookTime(telemetry.dt_ms)));
  exec.appendChild(cookStat);

  // VRAM delta
  const vramStr = formatBytes(telemetry.vram_delta);
  if (vramStr) {
    const vramStat = el("span", "mmb-ni-stat");
    vramStat.textContent = "VRAM: ";
    vramStat.appendChild(el("span", "mmb-ni-stat-value", vramStr));
    exec.appendChild(vramStat);
  }

  // RAM delta
  const ramStr = formatBytes(telemetry.ram_delta);
  if (ramStr) {
    const ramStat = el("span", "mmb-ni-stat");
    ramStat.textContent = "RAM: ";
    ramStat.appendChild(el("span", "mmb-ni-stat-value", ramStr));
    exec.appendChild(ramStat);
  }

  // Cache size
  const cacheBytes = outputProfile?.cache_bytes;
  if (cacheBytes != null && cacheBytes > 0) {
    const cacheStat = el("span", "mmb-ni-stat");
    cacheStat.textContent = "Cache: ";
    cacheStat.appendChild(el("span", "mmb-ni-stat-value", formatBytesAbsolute(cacheBytes)));
    exec.appendChild(cacheStat);
  }

  _appendExecCount();
}

// ---------------------------------------------------------------------------
// Input slot view
// ---------------------------------------------------------------------------
function renderInputSlot(root, target, schema, telemetry, liveNode, outputProfile, inputProfiles) {
  // Resolve wire color from the input type
  let slotWireColor = null;
  if (schema) {
    const defs = { ...(schema.input?.required || {}), ...(schema.input?.optional || {}) };
    const s = defs[target.input_name];
    if (s) {
      const t = Array.isArray(s) ? s[0] : s;
      slotWireColor = getWireColor(Array.isArray(t) ? "COMBO" : String(t));
    }
  }

  const header = el("div", "mmb-ni-slot-header");
  header.appendChild(el("span", "mmb-ni-slot-direction", "Input"));
  const nameEl = el("span", "mmb-ni-slot-name", target.input_name);
  if (slotWireColor) nameEl.style.color = slotWireColor;
  header.appendChild(nameEl);
  root.appendChild(header);

  root.appendChild(el("div", "mmb-ni-provenance",
    `${target.title || target.node_type} #${target.node_id}`));

  if (schema) {
    const inputDefs = { ...(schema.input?.required || {}), ...(schema.input?.optional || {}) };
    const spec = inputDefs[target.input_name];
    if (spec) {
      const typeName = Array.isArray(spec) ? spec[0] : spec;
      const displayType = Array.isArray(typeName) ? "COMBO" : String(typeName);
      const typeEl = el("div", "mmb-ni-slot-type", displayType);
      if (slotWireColor) typeEl.style.color = slotWireColor;
      root.appendChild(typeEl);

      const explanation = getTypeExplanation(displayType);
      if (explanation) {
        root.appendChild(el("div", "mmb-ni-type-explain", explanation));
      }

      if (Array.isArray(typeName) && typeName.length <= 20) {
        root.appendChild(sep());
        root.appendChild(el("div", "mmb-ni-section-label", "Options"));
        root.appendChild(el("div", "mmb-ni-io-value", truncate(typeName.join(", "), 200)));
      }
    }
  }

  root.appendChild(sep());
  if (target.link_id != null && liveNode) {
    const graph = window.app?.graph;
    if (graph) {
      const link = graph.links?.[target.link_id] || graph._links?.get?.(target.link_id);
      if (link) {
        const srcNode = graph.getNodeById(link.origin_id);
        const srcName = srcNode ? (srcNode.title || srcNode.type) : `#${link.origin_id}`;
        const srcSlot = srcNode?.outputs?.[link.origin_slot]?.name || `slot ${link.origin_slot}`;
        const info = el("div", "mmb-ni-connection-info");
        info.appendChild(document.createTextNode("\u2190 "));
        info.appendChild(el("strong", null, srcName));
        info.appendChild(document.createTextNode(` \u00B7 ${srcSlot}`));
        root.appendChild(info);

        // Show upstream thumbnail for this input if available
        const upId = String(link.origin_id);
        const upSlot = link.origin_slot;
        const upProfile = inputProfiles?.get?.(upId);
        if (upProfile?.outputs?.[upSlot]) {
          const slotProfile = upProfile.outputs[upSlot];
          const kind = slotProfile.kind;

          if (kind === "IMAGE" || kind === "MASK" || kind === "LATENT" || kind === "LATENT_SAMPLES") {
            const batch = slotProfile.batch || 1;
            const isSeq = batch > 1;
            const dtypeSuffix = _dtypeDeviceSuffix(slotProfile);
            root.appendChild(sep());

            if (kind === "IMAGE") {
              const info = el("div", "mmb-ni-output-info");
              if (isSeq) info.appendChild(sequenceIcon());
              info.appendChild(document.createTextNode(
                `${slotProfile.width}\u00D7${slotProfile.height} \u00D7 ${batch} frame${batch !== 1 ? "s" : ""} \u2022 ${slotProfile.channels || 3}ch${dtypeSuffix}`));
              root.appendChild(info);
            } else if (kind === "MASK") {
              const info = el("div", "mmb-ni-output-info");
              if (isSeq) info.appendChild(sequenceIcon());
              info.appendChild(document.createTextNode(
                `${slotProfile.width}\u00D7${slotProfile.height} \u00D7 ${batch} frame${batch !== 1 ? "s" : ""}${dtypeSuffix}`));
              root.appendChild(info);
            } else {
              const info = el("div", "mmb-ni-output-info");
              if (isSeq) info.appendChild(sequenceIcon());
              info.appendChild(document.createTextNode(
                `Latent ${slotProfile.latent_width || "?"}\u00D7${slotProfile.latent_height || "?"} (${slotProfile.approx_width || "?"}\u00D7${slotProfile.approx_height || "?"} px)${dtypeSuffix}`));
              root.appendChild(info);
            }

            const thumbB64 = upProfile.thumbnails?.[String(upSlot)];
            if (thumbB64) {
              const thumbContainer = el("div", "mmb-ni-thumb-container");
              const img = document.createElement("img");
              img.src = `data:image/jpeg;base64,${thumbB64}`;
              img.className = "mmb-ni-thumb";
              img.alt = `${target.input_name} input preview`;
              thumbContainer.appendChild(img);
              if (isSeq && (kind === "IMAGE" || kind === "MASK")) {
                thumbContainer.appendChild(sequenceBadge(batch));
              }
              root.appendChild(thumbContainer);
            }
          }
        }
      }
    }
  } else {
    root.appendChild(el("div", "mmb-ni-connection-info mmb-ni-stat--muted", "Not connected"));
  }

  renderExecStats(root, telemetry, outputProfile);
}

// ---------------------------------------------------------------------------
// Output slot view
// ---------------------------------------------------------------------------
function renderOutputSlot(root, target, schema, telemetry, liveNode, outputProfile) {
  // Resolve wire color from the output type
  let slotWireColor = null;
  if (schema) {
    const oTypes = schema.output || [];
    const t = oTypes[target.output_index];
    if (t) slotWireColor = getWireColor(String(t));
  }

  const header = el("div", "mmb-ni-slot-header");
  header.appendChild(el("span", "mmb-ni-slot-direction", "Output"));
  const nameEl = el("span", "mmb-ni-slot-name", target.output_name);
  if (slotWireColor) nameEl.style.color = slotWireColor;
  header.appendChild(nameEl);
  root.appendChild(header);

  root.appendChild(el("div", "mmb-ni-provenance",
    `${target.title || target.node_type} #${target.node_id}`));

  if (schema) {
    const outputTypes = schema.output || [];
    const typeName = outputTypes[target.output_index];
    if (typeName) {
      const typeEl = el("div", "mmb-ni-slot-type", String(typeName));
      if (slotWireColor) typeEl.style.color = slotWireColor;
      root.appendChild(typeEl);
      const explanation = getTypeExplanation(String(typeName));
      if (explanation) root.appendChild(el("div", "mmb-ni-type-explain", explanation));
    }
  }

  // Profile data for this slot
  const slotProfile = outputProfile?.outputs?.[target.output_index];
  if (slotProfile) {
    const kind = slotProfile.kind;
    const batch = slotProfile.batch || 1;
    const isSeq = batch > 1;
    const dtypeSuffix = _dtypeDeviceSuffix(slotProfile);

    if (kind === "IMAGE") {
      const info = el("div", "mmb-ni-output-info");
      if (isSeq) info.appendChild(sequenceIcon());
      info.appendChild(document.createTextNode(
        `${slotProfile.width}\u00D7${slotProfile.height} \u00D7 ${batch} frame${batch !== 1 ? "s" : ""}${dtypeSuffix}`));
      root.appendChild(info);
    } else if (kind === "MASK") {
      const info = el("div", "mmb-ni-output-info");
      if (isSeq) info.appendChild(sequenceIcon());
      info.appendChild(document.createTextNode(
        `${slotProfile.width}\u00D7${slotProfile.height} \u00D7 ${batch} frame${batch !== 1 ? "s" : ""}${dtypeSuffix}`));
      root.appendChild(info);
    } else if (kind === "LATENT" || kind === "LATENT_SAMPLES") {
      const info = el("div", "mmb-ni-output-info");
      if (isSeq) info.appendChild(sequenceIcon());
      info.appendChild(document.createTextNode(
        `Latent ${slotProfile.latent_width}\u00D7${slotProfile.latent_height} (${slotProfile.approx_width}\u00D7${slotProfile.approx_height} px)${dtypeSuffix}`));
      root.appendChild(info);
    } else if (kind === "NUMBER") {
      root.appendChild(el("div", "mmb-ni-output-info", `Value: ${slotProfile.value}`));
    } else if (kind === "STRING") {
      root.appendChild(el("div", "mmb-ni-output-info", `"${truncate(slotProfile.value, 100)}"`));
    } else if (kind === "BOOLEAN") {
      root.appendChild(el("div", "mmb-ni-output-info", `Value: ${slotProfile.value}`));
    }

    const thumbB64 = outputProfile?.thumbnails?.[String(target.output_index)];
    if (thumbB64) {
      const thumbContainer = el("div", "mmb-ni-thumb-container");
      const img = document.createElement("img");
      img.src = `data:image/jpeg;base64,${thumbB64}`;
      img.className = "mmb-ni-thumb";
      img.alt = `${kind} preview`;
      thumbContainer.appendChild(img);
      if (isSeq && (kind === "IMAGE" || kind === "MASK")) {
        thumbContainer.appendChild(sequenceBadge(batch));
      }
      root.appendChild(thumbContainer);
    }
  }

  // Downstream connections
  root.appendChild(sep());
  const links = target.links || [];
  if (links.length > 0) {
    root.appendChild(el("div", "mmb-ni-section-label", `Connections (${links.length})`));
    const graph = window.app?.graph;
    if (graph) {
      for (const linkId of links.slice(0, 10)) {
        const link = graph.links?.[linkId] || graph._links?.get?.(linkId);
        if (link) {
          const dstNode = graph.getNodeById(link.target_id);
          const dstName = dstNode ? (dstNode.title || dstNode.type) : `#${link.target_id}`;
          const dstSlot = dstNode?.inputs?.[link.target_slot]?.name || `slot ${link.target_slot}`;
          const info = el("div", "mmb-ni-connection-info");
          info.appendChild(document.createTextNode("\u2192 "));
          info.appendChild(el("strong", null, dstName));
          info.appendChild(document.createTextNode(` \u00B7 ${dstSlot}`));
          root.appendChild(info);
        }
      }
      if (links.length > 10) {
        root.appendChild(el("div", "mmb-ni-stat--muted", `\u2026 and ${links.length - 10} more`));
      }
    }
  } else {
    root.appendChild(el("div", "mmb-ni-connection-info mmb-ni-stat--muted", "No connections"));
  }

  renderExecStats(root, telemetry, outputProfile);
}

// ---------------------------------------------------------------------------
// Validation warnings (disconnected required inputs)
// ---------------------------------------------------------------------------

// Primitive types always have a widget fallback — never need a connection
const _WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN"]);

function renderValidationWarnings(root, schema, liveNode) {
  if (!schema?.input?.required || !liveNode) return;
  const warnings = [];
  const reqInputs = schema.input.required;

  for (const [name, spec] of Object.entries(reqInputs)) {
    const typeName = Array.isArray(spec) ? spec[0] : spec;
    // COMBO (array of options) = widget with defaults — skip
    if (Array.isArray(typeName)) continue;
    // Primitive widget types always have a value fallback — skip
    const typeStr = String(typeName).toUpperCase();
    if (_WIDGET_TYPES.has(typeStr)) continue;
    // Check if this is a slot input on the live node
    const inp = liveNode.inputs?.find(i => i.name === name);
    if (!inp) continue; // not exposed as a slot at all
    if (inp.link != null) continue; // connected — no problem
    // Last check: does a widget with this name exist on the node?
    // If so, this is a "converted to input" widget with a fallback value — skip
    const hasWidgetFallback = liveNode.widgets?.some(w => w.name === name);
    if (hasWidgetFallback) continue;
    warnings.push(`\u201C${name}\u201D (${typeName}) is not connected`);
  }

  if (warnings.length === 0) return;
  const section = el("div", "mmb-ni-warnings");
  for (const w of warnings) {
    section.appendChild(el("div", "mmb-ni-warning-item", `\u26A0 ${w}`));
  }
  root.appendChild(section);
}

// ---------------------------------------------------------------------------
// Error section (last execution error)
// ---------------------------------------------------------------------------
function renderErrorSection(root, lastError) {
  if (!lastError) return;
  root.appendChild(sep());
  const section = el("div", "mmb-ni-error-section");
  section.appendChild(el("div", "mmb-ni-section-label mmb-ni-error-label", "Last Error"));
  if (lastError.type) {
    section.appendChild(el("div", "mmb-ni-error-type", lastError.type));
  }
  section.appendChild(el("div", "mmb-ni-error-message", truncate(lastError.message, 200)));
  root.appendChild(section);
}

// ---------------------------------------------------------------------------
// Action buttons (pinned panel only)
// ---------------------------------------------------------------------------
function renderActions(root, target, liveNode, options) {
  if (!options.isPinned) return;
  root.appendChild(sep());

  const bar = el("div", "mmb-ni-actions");

  // Copy buttons
  bar.appendChild(_actionButton("Copy ID", () => _copyToClipboard(String(target.node_id))));
  bar.appendChild(_actionButton("Copy Type", () => _copyToClipboard(target.node_type)));
  bar.appendChild(_actionButton("Copy Prompt", () => {
    const data = { [target.node_id]: { class_type: target.node_type, inputs: {} } };
    const wv = {};
    if (liveNode?.widgets) {
      for (const w of liveNode.widgets) {
        if (w.name && w.value !== undefined) wv[w.name] = w.value;
      }
    }
    data[target.node_id].inputs = wv;
    _copyToClipboard(JSON.stringify(data, null, 2));
  }));

  // Jump buttons
  bar.appendChild(_actionButton("Center", () => {
    const canvas = window.app?.canvas;
    if (canvas && liveNode) canvas.centerOnNode(liveNode);
  }));
  bar.appendChild(_actionButton("\u2191 Upstream", () => _selectConnected(liveNode, "upstream")));
  bar.appendChild(_actionButton("\u2193 Downstream", () => _selectConnected(liveNode, "downstream")));

  root.appendChild(bar);
}

function _actionButton(label, onClick) {
  const btn = el("button", "mmb-ni-action-btn", label);
  btn.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return btn;
}

function _copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(() => {});
}

function _selectConnected(node, direction) {
  const canvas = window.app?.canvas;
  const graph = canvas?.graph || window.app?.graph;
  if (!graph || !canvas || !node) return;

  const toSelect = [];
  if (direction === "upstream") {
    if (node.inputs) {
      for (const inp of node.inputs) {
        if (inp.link != null) {
          const link = graph.links?.[inp.link] || graph._links?.get?.(inp.link);
          if (link) {
            const n = graph.getNodeById(link.origin_id);
            if (n) toSelect.push(n);
          }
        }
      }
    }
  } else {
    if (node.outputs) {
      for (const out of node.outputs) {
        if (out.links) {
          for (const lid of out.links) {
            const link = graph.links?.[lid] || graph._links?.get?.(lid);
            if (link) {
              const n = graph.getNodeById(link.target_id);
              if (n) toSelect.push(n);
            }
          }
        }
      }
    }
  }

  canvas.deselectAll();
  for (const n of toSelect) canvas.selectNode(n, true);
  canvas.setDirty(true, true);
}
