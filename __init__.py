"""Xavi's Utils — Houdini/Nuke-style UX tools for ComfyUI."""

import io as _io_mod
import base64
import time
import os
import sys
import logging
import json

logger = logging.getLogger("ComfyUI_XavisUtils")

WEB_DIRECTORY = "./js"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# ---------------------------------------------------------------------------
# Optional dependencies
# ---------------------------------------------------------------------------
try:
    import torch
    _has_torch = True
except ImportError:
    _has_torch = False

try:
    import psutil
    _has_psutil = True
except ImportError:
    _has_psutil = False

try:
    from PIL import Image
    _has_pil = True
except ImportError:
    _has_pil = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
class _NodeRun:
    __slots__ = ("t0_ns", "vram0", "ram0")

    def __init__(self, t0_ns, vram0, ram0):
        self.t0_ns = t0_ns
        self.vram0 = vram0
        self.ram0 = ram0


def _get_vram():
    if not _has_torch:
        return None
    if torch.cuda.is_available():
        return int(torch.cuda.memory_allocated())
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        try:
            return int(torch.mps.current_allocated_memory())
        except Exception:
            return None
    return None


def _get_ram():
    if not _has_psutil:
        return None
    try:
        return int(psutil.Process(os.getpid()).memory_info().rss)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Output profiling utilities
# ---------------------------------------------------------------------------
_THUMB_MAX = 128  # Max thumbnail dimension

def _profile_single_output(value):
    """Profile a single output value. Returns a dict of metadata.
    NEVER transfers tensors from GPU to CPU for full data -- only reads
    shape/dtype/device metadata and computes lightweight stats."""
    info = {"type": type(value).__name__}

    if _has_torch and isinstance(value, torch.Tensor):
        shape = list(value.shape)
        info["tensor"] = True
        info["shape"] = shape
        info["dtype"] = str(value.dtype)
        info["device"] = str(value.device)
        info["numel"] = value.numel()
        info["bytes"] = value.numel() * value.element_size()

        # Determine if this is an IMAGE, MASK, or LATENT based on shape
        ndim = len(shape)
        if ndim == 4 and shape[-1] in (1, 3, 4):
            # IMAGE: [B, H, W, C]
            info["kind"] = "IMAGE"
            info["batch"] = shape[0]
            info["height"] = shape[1]
            info["width"] = shape[2]
            info["channels"] = shape[3]
        elif ndim == 4 and shape[1] in (4, 8, 16):
            # LATENT samples: [B, C, H, W]
            info["kind"] = "LATENT_SAMPLES"
            info["batch"] = shape[0]
            info["latent_channels"] = shape[1]
            info["latent_height"] = shape[2]
            info["latent_width"] = shape[3]
            # Approximate pixel resolution (latent is typically 8x downscaled)
            info["approx_height"] = shape[2] * 8
            info["approx_width"] = shape[3] * 8
        elif ndim == 3:
            # MASK: [B, H, W]
            info["kind"] = "MASK"
            info["batch"] = shape[0]
            info["height"] = shape[1]
            info["width"] = shape[2]
        return info

    elif isinstance(value, dict):
        info["dict_keys"] = list(value.keys())[:20]
        # Check for LATENT dict
        if "samples" in value and _has_torch and isinstance(value["samples"], torch.Tensor):
            samples = value["samples"]
            shape = list(samples.shape)
            info["kind"] = "LATENT"
            info["tensor"] = True
            info["shape"] = shape
            info["dtype"] = str(samples.dtype)
            info["device"] = str(samples.device)
            info["bytes"] = samples.numel() * samples.element_size()
            if len(shape) == 4:
                info["batch"] = shape[0]
                info["latent_channels"] = shape[1]
                info["latent_height"] = shape[2]
                info["latent_width"] = shape[3]
                info["approx_height"] = shape[2] * 8
                info["approx_width"] = shape[3] * 8
        # Check for AUDIO dict
        elif "waveform" in value and _has_torch and isinstance(value.get("waveform"), torch.Tensor):
            wf = value["waveform"]
            info["kind"] = "AUDIO"
            info["shape"] = list(wf.shape)
            info["sample_rate"] = value.get("sample_rate")
            if len(wf.shape) == 3:
                info["channels"] = wf.shape[1]
                info["samples"] = wf.shape[2]
                sr = value.get("sample_rate", 44100)
                info["duration_s"] = round(wf.shape[2] / sr, 2) if sr else None
        return info

    elif isinstance(value, (int, float)):
        info["value"] = value
        info["kind"] = "NUMBER"
        return info

    elif isinstance(value, str):
        info["value"] = value[:500]  # cap string preview
        info["length"] = len(value)
        info["kind"] = "STRING"
        return info

    elif isinstance(value, bool):
        info["value"] = value
        info["kind"] = "BOOLEAN"
        return info

    elif isinstance(value, list):
        info["length"] = len(value)
        # Profile first element if available
        if len(value) > 0:
            info["first_element"] = _profile_single_output(value[0])
        return info

    else:
        info["repr"] = repr(value)[:200]
        return info


def _generate_thumbnail_b64(value, kind):
    """Generate a base64-encoded JPEG thumbnail for IMAGE or MASK tensors.
    Only works if PIL is available and tensor is on CPU or can be read safely."""
    if not _has_pil or not _has_torch:
        return None
    if not isinstance(value, torch.Tensor):
        return None

    try:
        if kind == "IMAGE":
            # [B, H, W, C] - take first in batch, clamp, convert
            img_tensor = value[0].detach()
            if img_tensor.device.type != "cpu":
                img_tensor = img_tensor.cpu()
            img_np = (img_tensor.clamp(0, 1) * 255).byte().numpy()
            if img_np.shape[-1] == 1:
                img = Image.fromarray(img_np[:, :, 0], mode="L")
            elif img_np.shape[-1] == 4:
                img = Image.fromarray(img_np, mode="RGBA")
            else:
                img = Image.fromarray(img_np[:, :, :3], mode="RGB")

        elif kind == "MASK":
            # [B, H, W] - take first in batch
            mask_tensor = value[0].detach()
            if mask_tensor.device.type != "cpu":
                mask_tensor = mask_tensor.cpu()
            mask_np = (mask_tensor.clamp(0, 1) * 255).byte().numpy()
            img = Image.fromarray(mask_np, mode="L")

        else:
            return None

        # Thumbnail
        img.thumbnail((_THUMB_MAX, _THUMB_MAX), Image.Resampling.LANCZOS)
        buf = _io_mod.BytesIO()
        img.save(buf, format="JPEG", quality=75)
        return base64.b64encode(buf.getvalue()).decode("ascii")

    except Exception as e:
        logger.debug(f"Thumbnail generation failed: {e}")
        return None


def _estimate_cache_bytes(outputs):
    """Estimate memory usage of cached outputs (without deep-copying anything)."""
    total = 0
    if outputs is None:
        return 0

    def _scan(obj):
        nonlocal total
        if obj is None:
            return
        if _has_torch and isinstance(obj, torch.Tensor):
            total += obj.numel() * obj.element_size()
        elif isinstance(obj, dict):
            for v in obj.values():
                _scan(v)
        elif isinstance(obj, (list, tuple)):
            for item in obj:
                _scan(item)
        elif isinstance(obj, str):
            total += len(obj)
        elif isinstance(obj, (int, float, bool)):
            total += 8
        elif hasattr(obj, "get_ram_usage"):
            try:
                total += obj.get_ram_usage()
            except Exception:
                pass

    _scan(outputs)
    return total


# ---------------------------------------------------------------------------
# Telemetry store (persists cook times across cache re-runs)
# ---------------------------------------------------------------------------
class _TelemetryStore:
    """Stores telemetry for nodes, persisting last_cook_time even when cached."""

    def __init__(self):
        self._data = {}  # node_id -> dict

    def record(self, node_id, dt_ms, vram_delta, ram_delta, cached):
        nid = str(node_id)
        existing = self._data.get(nid, {})
        if cached:
            # Preserve the last cook time from when it actually ran
            existing["cached"] = True
            existing.setdefault("last_cook_ms", None)  # keep old value
        else:
            existing["last_cook_ms"] = round(dt_ms, 2)
            existing["vram_delta"] = vram_delta
            existing["ram_delta"] = ram_delta
            existing["cached"] = False
        self._data[nid] = existing

    def get(self, node_id):
        return self._data.get(str(node_id))

    def clear(self):
        self._data.clear()

_telemetry_store = _TelemetryStore()


# ---------------------------------------------------------------------------
# Progress handler
# ---------------------------------------------------------------------------
class _InspectorProgressHandler:
    """ProgressHandler that measures cook time and memory deltas per node."""

    def __init__(self, server_instance):
        self.name = "mmb_inspector"
        self.enabled = True
        self.server = server_instance
        self._runs = {}  # (prompt_id, node_id) -> _NodeRun
        self._registry = None

    def set_registry(self, registry):
        self._registry = registry

    def start_handler(self, node_id, state, prompt_id):
        self._runs[(prompt_id, node_id)] = _NodeRun(
            t0_ns=time.perf_counter_ns(),
            vram0=_get_vram(),
            ram0=_get_ram(),
        )

    def update_handler(self, node_id, value, max_value, state, prompt_id, image=None):
        pass  # MVP: no per-step handling

    def finish_handler(self, node_id, state, prompt_id):
        run = self._runs.pop((prompt_id, node_id), None)

        if run is None:
            cached = True
            dt_ms = 0.0
            dvram = None
            dram = None
        else:
            cached = False
            dt_ms = (time.perf_counter_ns() - run.t0_ns) / 1e6
            v1 = _get_vram()
            r1 = _get_ram()
            dvram = (v1 - run.vram0) if (v1 is not None and run.vram0 is not None) else None
            dram = (r1 - run.ram0) if (r1 is not None and run.ram0 is not None) else None

        # Resolve display_node_id for expanded/subgraph nodes
        display_node_id = node_id
        if self._registry and hasattr(self._registry, "dynprompt") and self._registry.dynprompt:
            try:
                display_node_id = self._registry.dynprompt.get_display_node_id(node_id)
            except Exception:
                pass

        # Store in persistent telemetry (survives cache re-runs)
        _telemetry_store.record(str(display_node_id), dt_ms, dvram, dram, cached)

        self.server.send_sync("mmb_inspector.telemetry", {
            "prompt_id": prompt_id,
            "node_id": node_id,
            "display_node_id": display_node_id,
            "dt_ms": round(dt_ms, 2),
            "vram_delta": dvram,
            "ram_delta": dram,
            "cached": cached,
            "last_cook_ms": _telemetry_store.get(str(display_node_id)).get("last_cook_ms"),
        })

    def reset(self):
        self._runs.clear()

    def enable(self):
        self.enabled = True

    def disable(self):
        self.enabled = False


# ---------------------------------------------------------------------------
# REST API routes for on-demand output profiling
# ---------------------------------------------------------------------------
def _setup_routes(server_instance):
    """Register REST endpoints for the inspector."""
    from aiohttp import web

    @server_instance.routes.get("/mmb_inspector/outputs/{node_id}")
    async def get_node_outputs(request):
        """Profile cached outputs for a given node_id."""
        node_id = request.match_info["node_id"]
        include_thumbs = request.query.get("thumbs", "1") == "1"

        # Access the executor's cache via our patched reference
        caches = None
        try:
            pe = getattr(server_instance, "_mmb_inspector_executor", None)
            if pe is not None and hasattr(pe, "caches"):
                caches = pe.caches
        except Exception as e:
            logger.debug(f"Cache access failed: {e}")

        if caches is None:
            return web.json_response({"error": "cache_unavailable"}, status=503)

        cache_entry = caches.outputs.get(node_id)
        if cache_entry is None:
            return web.json_response({"error": "not_cached", "node_id": node_id}, status=404)

        outputs = cache_entry.outputs  # list of tuples
        if outputs is None:
            return web.json_response({"error": "no_outputs", "node_id": node_id}, status=404)

        # Profile each output
        output_profiles = []
        thumbnails = {}
        try:
            # outputs is a list (one per batch/map call), each element is a tuple of return values
            if isinstance(outputs, (list, tuple)) and len(outputs) > 0:
                first_result = outputs[0] if not isinstance(outputs[0], (list, tuple)) else outputs[0]
                if isinstance(first_result, (list, tuple)):
                    # Standard: outputs[0] is the first batch result tuple
                    for idx, val in enumerate(first_result):
                        profile = _profile_single_output(val)
                        output_profiles.append(profile)

                        # Generate thumbnail for IMAGE/MASK
                        kind = profile.get("kind", "")
                        if include_thumbs and kind in ("IMAGE", "MASK"):
                            thumb = _generate_thumbnail_b64(val, kind)
                            if thumb:
                                thumbnails[str(idx)] = thumb
                else:
                    # Single return value
                    profile = _profile_single_output(first_result)
                    output_profiles.append(profile)
                    kind = profile.get("kind", "")
                    if include_thumbs and kind in ("IMAGE", "MASK"):
                        thumb = _generate_thumbnail_b64(first_result, kind)
                        if thumb:
                            thumbnails["0"] = thumb
        except Exception as e:
            logger.debug(f"Output profiling failed: {e}")
            return web.json_response({"error": "profiling_failed", "detail": str(e)}, status=500)

        # Estimate cache memory
        cache_bytes = _estimate_cache_bytes(outputs)

        # Get stored telemetry
        stored_telemetry = _telemetry_store.get(node_id)

        result = {
            "node_id": node_id,
            "output_count": len(output_profiles),
            "outputs": output_profiles,
            "cache_bytes": cache_bytes,
            "thumbnails": thumbnails,
        }
        if stored_telemetry:
            result["last_cook_ms"] = stored_telemetry.get("last_cook_ms")

        return web.json_response(result)

    logger.info("XavisUtils: REST routes registered.")


# ---------------------------------------------------------------------------
# Registration (runs at import time, after server is up)
# ---------------------------------------------------------------------------
import gc  # for cache discovery fallback

def _setup_handler():
    """Register the InspectorProgressHandler with ComfyUI's progress system."""
    try:
        from comfy_execution import progress
        from server import PromptServer
    except ImportError:
        logger.warning(
            "XavisUtils: Could not import progress/server modules. "
            "Backend telemetry disabled."
        )
        return

    server_instance = PromptServer.instance
    handler = _InspectorProgressHandler(server_instance)

    try:
        progress.add_progress_handler(handler)
    except Exception:
        logger.warning("XavisUtils: add_progress_handler failed.")
        return

    # Patch reset_progress_state to re-add our handler after each reset
    _original_reset = progress.reset_progress_state

    def _patched_reset(*args, **kwargs):
        _original_reset(*args, **kwargs)
        try:
            progress.add_progress_handler(handler)
        except Exception:
            pass

    progress.reset_progress_state = _patched_reset

    for mod_path in ("comfy_execution.caching_utils", "execution"):
        try:
            import importlib
            mod = importlib.import_module(mod_path)
            if hasattr(mod, "reset_progress_state"):
                setattr(mod, "reset_progress_state", _patched_reset)
        except (ImportError, AttributeError):
            pass

    # Setup REST routes
    try:
        _setup_routes(server_instance)
    except Exception as e:
        logger.warning(f"XavisUtils: Route setup failed: {e}")

    # Patch PromptExecutor to store reference on the server for cache access
    try:
        import execution as exec_mod
        _original_init = exec_mod.PromptExecutor.__init__

        def _patched_executor_init(self, server_obj, *args, **kwargs):
            _original_init(self, server_obj, *args, **kwargs)
            server_obj._mmb_inspector_executor = self

        exec_mod.PromptExecutor.__init__ = _patched_executor_init

        # Also patch the server instance if executor already exists
        # (in case __init__ already ran before our patch)
    except Exception as e:
        logger.debug(f"PromptExecutor patch failed: {e}")

    logger.info("XavisUtils: Backend telemetry handler registered.")


_setup_handler()
