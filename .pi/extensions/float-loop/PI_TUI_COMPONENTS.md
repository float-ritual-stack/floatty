# pi-tui Components Reference

Available UI components and patterns for the float-loop extension.

## Built-in Components (from `@mariozechner/pi-tui`)

### Layout Components

| Component | Purpose | Usage |
|-----------|---------|-------|
| `Text` | Multi-line text with word wrapping | `new Text(content, paddingX, paddingY, bgFn)` |
| `Box` | Container with padding and background | `new Box(paddingX, paddingY, bgFn)` |
| `Container` | Groups children vertically | `container.addChild(component)` |
| `Spacer` | Empty vertical space | `new Spacer(lines)` |
| `Markdown` | Renders markdown with syntax highlighting | `new Markdown(content, paddingX, paddingY, theme)` |
| `Image` | Renders images (Kitty/iTerm2/Ghostty/WezTerm) | `new Image(base64Data, mimeType, theme, options)` |

### Interactive Components

| Component | Purpose | Example Use |
|-----------|---------|-------------|
| `SelectList` | Fuzzy-searchable list selector | Track selection, option picking |
| `SettingsList` | Toggle settings with values | Config options, feature flags |
| `Input` | Single-line text input | Search, naming |
| `BorderedLoader` | Async operation with cancel | Sweep running, fetching data |
| `DynamicBorder` | Themed border frames | Dialog boxes, panels |

### From `@mariozechner/pi-coding-agent`

| Component/Utility | Purpose |
|-------------------|---------|
| `CustomEditor` | Replace main input editor (vim mode, etc.) |
| `getSettingsListTheme()` | Theme for SettingsList |
| `getMarkdownTheme()` | Theme for Markdown component |

## UI Integration Methods (ctx.ui)

### Dialogs (Blocking)

```typescript
// Selection with fuzzy search
const choice = await ctx.ui.select("Pick one:", [
  { value: "a", label: "Option A", description: "Details" },
  { value: "b", label: "Option B" },
]);

// Confirmation
const ok = await ctx.ui.confirm("Delete?", "This cannot be undone");

// Text input
const name = await ctx.ui.input("Name:", "placeholder text");

// Multi-line editor
const text = await ctx.ui.editor("Edit:", "prefilled content");

// Custom component (full control)
const result = await ctx.ui.custom((tui, theme, keybindings, done) => {
  return myComponent;
});
```

### Notifications (Non-blocking)

```typescript
ctx.ui.notify("Message", "info");      // Blue/info
ctx.ui.notify("Warning", "warning");   // Yellow/warning
ctx.ui.notify("Error!", "error");      // Red/error
```

### Persistent UI

```typescript
// Status bar (footer)
ctx.ui.setStatus("float-loop", "🔥 active");
ctx.ui.setStatus("float-loop", undefined); // Clear

// Widget above/below editor
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"]);
ctx.ui.setWidget("my-widget", lines, { placement: "belowEditor" });
ctx.ui.setWidget("my-widget", undefined); // Clear

// Working message (during streaming)
ctx.ui.setWorkingMessage("Running sweep...");
ctx.ui.setWorkingMessage(); // Clear

// Custom footer (replaces entire footer)
ctx.ui.setFooter((tui, theme, footerData) => ({
  render(width) { return ["Custom footer"]; },
  invalidate() {},
  dispose: footerData.onBranchChange(() => tui.requestRender()),
}));
```

### Overlays (Floating UI)

```typescript
const result = await ctx.ui.custom((tui, theme, kb, done) => {
  return new MyDialog({ onClose: done });
}, {
  overlay: true,
  overlayOptions: {
    width: "50%",           // or number of columns
    minWidth: 40,
    maxHeight: "80%",
    anchor: "right-center", // center, top-left, top-center, etc.
    offsetX: -2,
    offsetY: 0,
    margin: 2,
    visible: (w, h) => w >= 80, // Responsive
  },
  onHandle: (handle) => {
    // handle.setHidden(true/false)
    // handle.hide()
  },
});
```

## Common Patterns

### Pattern 1: Selection Dialog

```typescript
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, SelectList, Text } from "@mariozechner/pi-tui";

const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
  const container = new Container();
  
  // Border + title
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
  container.addChild(new Text(theme.fg("accent", theme.bold("Select Track")), 1, 0));
  
  // SelectList with theming
  const selectList = new SelectList(items, Math.min(items.length, 10), {
    selectedPrefix: (t) => theme.fg("accent", t),
    selectedText: (t) => theme.fg("accent", t),
    description: (t) => theme.fg("muted", t),
    scrollInfo: (t) => theme.fg("dim", t),
  });
  selectList.onSelect = (item) => done(item.value);
  selectList.onCancel = () => done(null);
  container.addChild(selectList);
  
  // Help text + bottom border
  container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
  
  return {
    render: (w) => container.render(w),
    invalidate: () => container.invalidate(),
    handleInput: (data) => { selectList.handleInput(data); tui.requestRender(); },
  };
});
```

### Pattern 2: Async with Cancel

```typescript
import { BorderedLoader } from "@mariozechner/pi-coding-agent";

const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
  const loader = new BorderedLoader(tui, theme, "Running sweep...");
  loader.onAbort = () => done(null);
  
  runSweep(files).then((findings) => done(findings));
  
  return loader;
});
```

### Pattern 3: Settings/Toggles

```typescript
import { getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { SettingsList } from "@mariozechner/pi-tui";

const items = [
  { id: "autoSweep", label: "Auto sweep", currentValue: "on", values: ["on", "off"] },
  { id: "gateMode", label: "Gate enforcement", currentValue: "warn", values: ["block", "warn", "off"] },
];

await ctx.ui.custom((_tui, theme, _kb, done) => {
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", theme.bold("Settings")), 1, 1));
  
  const settingsList = new SettingsList(
    items,
    Math.min(items.length + 2, 15),
    getSettingsListTheme(),
    (id, newValue) => ctx.ui.notify(`${id} = ${newValue}`, "info"),
    () => done(undefined),
    { enableSearch: true },
  );
  container.addChild(settingsList);
  
  return {
    render: (w) => container.render(w),
    invalidate: () => container.invalidate(),
    handleInput: (data) => settingsList.handleInput?.(data),
  };
});
```

### Pattern 4: Compact Widget (Current Implementation)

```typescript
// Simple array of strings (no interactivity)
ctx.ui.setWidget("fl-track-widget", [
  "┌─ search-work ─",
  "🔥 Unit 2.1 │ In Progress",
  "",
  "Commands: /fl-unit, /fl-handoff",
  "└─────────────────",
]);

// With theme access
ctx.ui.setWidget("fl-track-widget", (_tui, theme) => {
  const active = extensionState.activeTrack;
  if (!active) return { render: () => [], invalidate: () => {} };
  
  const track = extensionState.tracks[active];
  return {
    render: () => [
      theme.fg("accent", `┌─ ${active} ─`),
      `🔥 ${track?.currentUnit || "planning"}`,
      theme.fg("dim", "Commands: /fl-unit, /fl-handoff"),
      theme.fg("accent", "└" + "─".repeat(20)),
    ],
    invalidate: () => {},
  };
});
```

## Keyboard Handling

```typescript
import { matchesKey, Key } from "@mariozechner/pi-tui";

handleInput(data: string): void {
  if (matchesKey(data, Key.up)) {
    this.selectedIndex--;
    this.invalidate(); // Clear cache
  } else if (matchesKey(data, Key.down)) {
    this.selectedIndex++;
    this.invalidate();
  } else if (matchesKey(data, Key.enter)) {
    this.onSelect?.(this.selectedIndex);
  } else if (matchesKey(data, Key.escape)) {
    this.onCancel?.();
  } else if (matchesKey(data, Key.ctrl("c"))) {
    // Handle Ctrl+C
  }
  
  // After state change, request re-render
  tui.requestRender();
}
```

## Theme Colors

### Foreground (`theme.fg(color, text)`)

| Category | Colors |
|----------|--------|
| General | `text`, `accent`, `muted`, `dim` |
| Status | `success`, `error`, `warning` |
| Tools | `toolTitle`, `toolOutput` |
| Diff | `toolDiffAdded`, `toolDiffRemoved` |
| Syntax | `syntaxComment`, `syntaxKeyword`, `syntaxFunction`, `syntaxString`, etc. |

### Background (`theme.bg(color, text)`)

`selectedBg`, `userMessageBg`, `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`

### Usage

```typescript
const styled = theme.fg("accent", theme.bold("Title"));
const dimmed = theme.fg("dim", "Secondary text");
const success = theme.fg("success", "✓ Complete");
const error = theme.fg("error", "✗ Failed");
```

## Performance Tips

1. **Cache render output** - Store `cachedLines` and `cachedWidth`, return cached if width unchanged
2. **Call `invalidate()` on state change** - Clears render cache
3. **Call `tui.requestRender()` after input handling** - Triggers redraw
4. **Use `truncateToWidth()` for long lines** - Ensures no overflow

## Widget vs Overlay vs Dialog

| UI Type | Use For | Persistence | Example |
|---------|---------|-------------|---------|
| **Widget** | Status, progress, current state | Until cleared | Track status above editor |
| **Status** | Mode indicators, brief state | Until changed | "🔥 active" in footer |
| **Dialog** | User choice required | Until dismissed | Select track, confirm |
| **Overlay** | Rich UI without clearing screen | Until closed | Track browser, settings |
| **Notification** | Brief feedback | Auto-dismiss | "Sweep complete" |

## Examples in Float Loop

| Feature | Component Pattern | Location |
|---------|-------------------|----------|
| Track widget | `setWidget` with string array | `showTrackWidget()` |
| Track browser | `ctx.ui.select()` with `SelectList` | `/fl-track` command |
| Settings | `SettingsList` | Future: `/fl-config` |
| Sweep running | `BorderedLoader` | Future: long-running sweep |
| Checklist | Custom interactive component | Future: Unit 0.2 |
| Handoff viewer | `Markdown` component | Future: Unit 2.3 |

## More Resources

- **Full examples**: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/`
- **Key files**: `plan-mode/`, `preset.ts`, `tools.ts`, `qna.ts`, `overlay-test.ts`
- **Games**: `snake.ts`, `space-invaders.ts` (advanced input handling)
- **Docs**: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/tui.md`
