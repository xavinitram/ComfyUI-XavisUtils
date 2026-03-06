# Contributing to Xavi's Utils

## Adding a New Feature

Each feature is a self-contained JS module in `js/`. Follow this pattern:

### 1. Create the module

Create `js/your-feature.js`. ComfyUI auto-discovers all `.js` files in the `js/` directory — no manual registration needed.

### 2. Structure

```js
import { app } from "../../scripts/app.js";
import { inGraph, getCurrentGraph, eventToGraphPos } from "./utils.js";

// Module-scoped settings state
let enabled = true;

// Feature logic...

app.registerExtension({
  name: "xavis.your_feature",

  settings: [
    {
      id: "xavis.yourFeature.Enabled",
      name: "Enable Your Feature",
      type: "boolean",
      defaultValue: true,
      category: ["Xavi's Utils", "Your Feature"],
      onChange: (v) => { enabled = !!v; },
    },
  ],

  async setup() {
    // Read initial settings
    try {
      const getSetting = app.extensionManager?.setting?.get
        ?? app.ui?.settings?.getSettingValue;
      if (getSetting) {
        const ctx = app.extensionManager?.setting ?? app.ui?.settings;
        const en = getSetting.call(ctx, "xavis.yourFeature.Enabled");
        if (en != null) enabled = !!en;
      }
    } catch (_) {}

    // Attach event listeners
    // ...

    console.log("[Xavi's Utils] Your Feature loaded.");
  },
});
```

### 3. Key conventions

- **Always use `getCurrentGraph()`** from `utils.js` instead of `app.graph`. This handles subgraphs.
- **Settings IDs** use `xavis.featureName.SettingName` format.
- **Settings category** is `["Xavi's Utils", "Feature Name"]`.
- **Extension name** is `"xavis.feature_name"` (snake_case).
- **Console logs** use `[Xavi's Utils]` prefix.
- **Event listeners** should be in capture phase (`true` as third argument) when they need to intercept before LiteGraph.
- **Never call `stopPropagation()`/`preventDefault()`** unless you are actively handling the event. Passive monitoring should leave events untouched.

### 4. Shared utilities

If your feature needs graph-space coordinate conversion, slot hit-testing, or node hit-testing, use the helpers in `utils.js` rather than reimplementing them. If you need a new shared utility, add it to `utils.js` and export it.

### 5. CSS

- Feature-specific styles go in a dedicated CSS file (e.g., `your-feature-styles.css`).
- Shared gesture/overlay styles go in `gesture-styles.css`.
- Load CSS from your module:
  ```js
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./your-feature-styles.css", import.meta.url).href;
  document.head.appendChild(link);
  ```

### 6. Backend changes

If your feature needs backend support (Python), add it to `__init__.py`. Use the existing patterns:
- REST endpoints go in `_setup_routes()`.
- WebSocket events use `server.send_sync("event_name", data)`.
- The logger is `logging.getLogger("ComfyUI_XavisUtils")`.

## Testing

There is no automated test suite yet. Test manually:

1. Start ComfyUI
2. Open browser dev tools console — check for `[Xavi's Utils]` log messages
3. Test each feature individually
4. Test with features disabled (via Settings)
5. Test inside subgraphs/group nodes

## Code Style

- No build step, no bundler — plain ES modules
- No external JS dependencies
- Prefer vanilla DOM manipulation over frameworks
- Use `const`/`let`, never `var`
- Comments for non-obvious logic; no JSDoc on trivial helpers

## Versioning

We follow semantic versioning. Bump in `pyproject.toml`:
- **Patch** (0.2.x): Bug fixes
- **Minor** (0.x.0): New features
- **Major** (x.0.0): Breaking changes
