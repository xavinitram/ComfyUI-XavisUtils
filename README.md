# Xavi's Utils for ComfyUI

Houdini/Nuke-style UX tools for ComfyUI. Five independently toggleable features that make the node editor feel more like a professional DCC tool.

## Features

### Node Inspector (MMB)

Hold your middle mouse button over any node, input, or output to see detailed information at a glance. No extra nodes, no clutter.

| Target | Information |
|--------|-------------|
| **Node body** | Title, ID, class, category, description, all inputs/outputs with types and wire colours, widget values, bypass/mute status, validation warnings, cook time, VRAM/RAM delta, cache size, execution count, dtype/device |
| **Input slot** | Port name, expected type, tensor layout, upstream connection info, cooked primitive values, image/mask thumbnails |
| **Output slot** | Port name, type, downstream connections, tensor layout, image/mask thumbnails |
| **After execution** | Cook time, VRAM/RAM deltas, image/mask/latent thumbnails with resolution, cache memory, last cook time (persisted through cache hits) |

**Persistent panel:** Ctrl+MMB pins the panel on screen with action buttons (Copy ID/Type/Prompt, Center, Jump to Upstream/Downstream).

**Settings** (ComfyUI Settings > Xavi's Utils > Node Inspector):

| Setting | Default | Range |
|---------|---------|-------|
| Enable | On | On/Off |
| Activation binding | `mmb` | `mmb`, `alt+mmb`, `ctrl+click` |
| Hold delay | 90 ms | 0 -- 500 ms |
| Drift threshold | 100 px | 1 -- 200 px |

### Shake to Disconnect

Rapidly shake a node left-right while dragging it to disconnect it from the graph. Where possible, upstream and downstream nodes are automatically re-wired to maintain the data flow.

Re-wire logic matches connections by type (IMAGE to IMAGE, MASK to MASK, etc.) using 1:1 index pairing. If a node has one IMAGE input and one IMAGE output, shaking it out preserves the wire between its parent and child.

**Settings** (Xavi's Utils > Shake Disconnect):

| Setting | Default | Range |
|---------|---------|-------|
| Enable | On | On/Off |
| Direction reversals | 3 | 2 -- 6 |
| Time window | 400 ms | 200 -- 800 ms |

### Wire Knife (Y + Drag)

Hold Y and click-drag to draw a knife line across the canvas. Any wires crossing the line are cut. Works like Houdini's wire-cutting gesture.

**Settings** (Xavi's Utils > Wire Knife):

| Setting | Default |
|---------|---------|
| Enable | On |

### Input Rewire (Drag from Input)

Click and drag from a **connected** input slot to create a new wire. Drop on a compatible output to replace the old connection. Drop on empty space to keep the old connection unchanged.

This makes input and output behaviour symmetrical: dragging from either end creates a new wire rather than picking up the existing one.

**Settings** (Xavi's Utils > Input Rewire):

| Setting | Default |
|---------|---------|
| Enable | On |

### Drop Node on Wire

Drag a node onto an existing wire to insert it into the connection. For example, dragging a Resize node (IMAGE in + IMAGE out) onto an IMAGE wire inserts it between the source and target nodes.

The node must have both a compatible input and output for the wire's type. A glowing highlight appears on the wire when a valid insertion is possible, and the matched slots are indicated on the node.

**Settings** (Xavi's Utils > Drop on Wire):

| Setting | Default |
|---------|---------|
| Enable | On |

## Installation

### Manual

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/xavinitram/ComfyUI-XavisUtils.git
```

Restart ComfyUI. No pip dependencies required.

### ComfyUI Manager

Search for **"Xavi's Utils"** in the Manager's Install Custom Nodes menu (once registered).

## Requirements

- ComfyUI with LiteGraph renderer
- No Python dependencies beyond ComfyUI's own (`torch` for telemetry, optional `PIL` for thumbnails, optional `psutil` for RAM tracking)

## License

MIT
