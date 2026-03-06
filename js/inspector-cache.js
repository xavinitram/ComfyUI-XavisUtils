/**
 * inspector-cache.js
 * Frontend caching layer:
 *  - /object_info fetched once at startup (node definitions)
 *  - Prompt-scoped telemetry from backend WebSocket push
 *  - On-demand output profile fetching from REST endpoint
 */

import { api } from "../../scripts/api.js";

// ---------------------------------------------------------------------------
// Object info cache  (node type -> definition)
// ---------------------------------------------------------------------------
let objectInfoCache = null;
let objectInfoPromise = null;

/**
 * Fetch /object_info once and cache. Returns the full map.
 * Safe to call multiple times (deduplicates).
 */
export async function preloadObjectInfo() {
  if (objectInfoCache) return objectInfoCache;
  if (objectInfoPromise) return objectInfoPromise;

  objectInfoPromise = api.fetchApi("/object_info")
    .then(r => r.json())
    .then(data => {
      objectInfoCache = data;
      objectInfoPromise = null;
      return data;
    })
    .catch(err => {
      console.warn("[Xavi's Utils] Failed to fetch /object_info:", err);
      objectInfoPromise = null;
      return null;
    });

  return objectInfoPromise;
}

/**
 * Get the cached schema for a node type string.
 * @param {string} nodeType
 * @returns {object|null}
 */
export function getNodeSchema(nodeType) {
  return objectInfoCache?.[nodeType] ?? null;
}

// ---------------------------------------------------------------------------
// Telemetry cache  (node_id -> TelemetryRecord, scoped to current prompt)
// ---------------------------------------------------------------------------
let currentPromptId = null;
const telemetryCache = new Map();

/**
 * Get cached telemetry for a node_id.
 * @param {string|number} nodeId
 * @returns {object|null}
 */
export function getTelemetry(nodeId) {
  return telemetryCache.get(String(nodeId)) ?? null;
}

/**
 * Clear all prompt-scoped caches.
 */
function clearPromptCaches() {
  telemetryCache.clear();
  outputProfileCache.clear();
}

// ---------------------------------------------------------------------------
// Execution count cache (session-scoped, never cleared)
// ---------------------------------------------------------------------------
const execCountCache = new Map();

/**
 * Get session execution count for a node.
 * @param {string|number} nodeId
 * @returns {number}
 */
export function getExecCount(nodeId) {
  return execCountCache.get(String(nodeId)) || 0;
}

// ---------------------------------------------------------------------------
// Error cache (session-scoped, never cleared)
// ---------------------------------------------------------------------------
const errorCache = new Map();

/**
 * Get the last execution error for a node, or null.
 * @param {string|number} nodeId
 * @returns {{ message: string, type: string, traceback: string } | null}
 */
export function getLastError(nodeId) {
  return errorCache.get(String(nodeId)) || null;
}

// ---------------------------------------------------------------------------
// Output profile cache (node_id -> profile from REST endpoint)
// ---------------------------------------------------------------------------
const outputProfileCache = new Map();
const outputProfileInFlight = new Map();

/**
 * Fetch output profile for a node from the backend REST endpoint.
 * Returns cached result if available, or triggers async fetch.
 * @param {string|number} nodeId
 * @param {boolean} includeThumbs
 * @returns {Promise<object|null>}
 */
export async function fetchOutputProfile(nodeId, includeThumbs = true) {
  const key = String(nodeId);

  // Return cached
  const cached = outputProfileCache.get(key);
  if (cached) return cached;

  // Deduplicate in-flight requests
  if (outputProfileInFlight.has(key)) {
    return outputProfileInFlight.get(key);
  }

  const thumbParam = includeThumbs ? "1" : "0";
  const promise = api.fetchApi(`/mmb_inspector/outputs/${key}?thumbs=${thumbParam}`)
    .then(r => {
      if (!r.ok) return null;
      return r.json();
    })
    .then(data => {
      outputProfileInFlight.delete(key);
      if (data && !data.error) {
        outputProfileCache.set(key, data);
        return data;
      }
      return null;
    })
    .catch(err => {
      outputProfileInFlight.delete(key);
      return null;
    });

  outputProfileInFlight.set(key, promise);
  return promise;
}

/**
 * Get cached output profile (synchronous, returns null if not yet fetched).
 */
export function getOutputProfile(nodeId) {
  return outputProfileCache.get(String(nodeId)) ?? null;
}

// ---------------------------------------------------------------------------
// WebSocket listeners
// ---------------------------------------------------------------------------

/**
 * Register WebSocket event listeners for execution lifecycle and
 * custom mmb_inspector.telemetry messages. Call once from setup().
 */
export function registerCacheListeners() {
  // New prompt starts -> clear stale data
  api.addEventListener("execution_start", (ev) => {
    currentPromptId = ev.detail?.prompt_id ?? null;
    clearPromptCaches();
  });

  // Nodes that were cache-hit (skipped execution)
  api.addEventListener("execution_cached", (ev) => {
    const detail = ev.detail;
    if (detail?.prompt_id !== currentPromptId) return;
    const nodes = detail.nodes || [];
    for (const nodeId of nodes) {
      const rec = telemetryCache.get(String(nodeId)) || {};
      rec.cached = true;
      rec.dt_ms = 0;
      telemetryCache.set(String(nodeId), rec);
    }
  });

  // Our custom telemetry from the backend ProgressHandler
  api.addEventListener("mmb_inspector.telemetry", (ev) => {
    const d = ev.detail;
    if (!d || d.prompt_id !== currentPromptId) return;

    const id = String(d.display_node_id ?? d.node_id);

    // If this is an expanded sub-node, aggregate cook time
    const existing = telemetryCache.get(id);
    if (existing && existing._aggregated) {
      existing.dt_ms = (existing.dt_ms || 0) + (d.dt_ms || 0);
      if (d.vram_delta != null) {
        existing.vram_delta = (existing.vram_delta || 0) + d.vram_delta;
      }
      if (d.ram_delta != null) {
        existing.ram_delta = (existing.ram_delta || 0) + d.ram_delta;
      }
      existing.cached = existing.cached && (d.cached ?? false);
      if (d.last_cook_ms != null) existing.last_cook_ms = d.last_cook_ms;
      return;
    }

    const isExpanded = String(d.display_node_id) !== String(d.node_id);

    telemetryCache.set(id, {
      dt_ms: d.dt_ms ?? 0,
      vram_delta: d.vram_delta ?? null,
      ram_delta: d.ram_delta ?? null,
      cached: d.cached ?? false,
      last_cook_ms: d.last_cook_ms ?? null,
      _aggregated: isExpanded,
    });

    // Increment session execution count (never cleared)
    const countId = String(d.display_node_id ?? d.node_id);
    execCountCache.set(countId, (execCountCache.get(countId) || 0) + 1);
  });

  // Execution errors — store last error per node (session-scoped)
  api.addEventListener("execution_error", (ev) => {
    const d = ev.detail;
    if (!d?.node_id) return;
    errorCache.set(String(d.node_id), {
      message: d.exception_message || "Unknown error",
      type: d.exception_type || "",
      traceback: d.traceback || "",
    });
  });
}
