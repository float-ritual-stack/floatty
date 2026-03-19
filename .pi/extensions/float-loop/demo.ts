/**
 * Float Loop UI Kitchen Sink Demo
 * 
 * Showcase of all pi-tui capabilities for reference.
 * Usage: /fl-demo [pattern]
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { 
  Text, Box, Container, Spacer, 
  SelectList, SettingsList, 
  matchesKey, Key, truncateToWidth 
} from "@mariozechner/pi-tui";

export function registerDemoCommand(pi: ExtensionAPI) {
  pi.registerCommand("fl-demo", {
    description: "UI kitchen sink demo - showcase all patterns",
    handler: async (args, ctx) => {
      const pattern = args?.trim() || "all";
      
      switch (pattern) {
        case "dialogs":
          await showDialogs(ctx);
          break;
        case "widgets":
          await showWidgets(ctx);
          break;
        case "notifications":
          await showNotifications(ctx);
          break;
        case "custom":
          await showCustomComponents(ctx);
          break;
        case "overlays":
          await showOverlays(ctx);
          break;
        case "themes":
          await showThemeColors(ctx);
          break;
        case "all":
        default:
          await runFullDemo(ctx);
          break;
      }
    },
  });
}

async function showDialogs(ctx: ExtensionContext) {
  // Select dialog with strings
  const choice = await ctx.ui.select("Demo: Select Dialog (strings)", [
    "Option A - First choice",
    "Option B - Second choice", 
    "Option C - Third choice",
  ]);
  ctx.ui.notify(`Selected: ${choice || "cancelled"}`, "info");
  
  // Select dialog with items (objects)
  const choice2 = await ctx.ui.select("Demo: Select Dialog (items)", [
    { value: "x", label: "Item X", description: "Extra details here" },
    { value: "y", label: "Item Y" },
    { value: "z", label: "Item Z", description: "More details" },
  ] as any); // Type cast for compatibility
  ctx.ui.notify(`Selected: ${choice2 || "cancelled"}`, "info");

  // Confirm dialog
  const confirmed = await ctx.ui.confirm("Demo: Confirm", "This is a confirmation dialog");
  ctx.ui.notify(`Confirmed: ${confirmed}`, "info");

  // Input dialog
  const text = await ctx.ui.input("Demo: Input", "Placeholder text here...");
  ctx.ui.notify(`Input: ${text || "cancelled"}`, "info");

  // Editor dialog
  const multiline = await ctx.ui.editor("Demo: Editor", "Prefilled\nmulti-line\ncontent");
  ctx.ui.notify(`Editor: ${multiline ? "submitted" : "cancelled"}`, "info");
}

async function showWidgets(ctx: ExtensionContext) {
  // Widget above editor
  ctx.ui.setWidget("demo-widget-above", [
    "┌─ Widget Above Editor ─",
    "│ This widget appears above the input",
    "│ It persists until cleared",
    "└─────────────────────────",
  ]);
  ctx.ui.notify("Widget set ABOVE editor", "info");
  
  await waitForEnter(ctx);

  // Clear and move below
  ctx.ui.setWidget("demo-widget-above", undefined);
  
  ctx.ui.setWidget("demo-widget-below", [
    "┌─ Widget Below Editor ─",
    "│ This widget appears below the input",
    "└─────────────────────────",
  ], { placement: "belowEditor" });
  ctx.ui.notify("Widget set BELOW editor", "info");
  
  await waitForEnter(ctx);
  ctx.ui.setWidget("demo-widget-below", undefined);
}

async function showNotifications(ctx: ExtensionContext) {
  ctx.ui.notify("This is an INFO notification (blue)", "info");
  await sleep(500);
  
  ctx.ui.notify("This is a WARNING notification (yellow)", "warning");
  await sleep(500);
  
  ctx.ui.notify("This is an ERROR notification (red)", "error");
  await sleep(500);
  
  // Working message during "work"
  ctx.ui.setWorkingMessage("Working on something...");
  await sleep(1500);
  ctx.ui.setWorkingMessage();
  
  ctx.ui.notify("Working message cleared", "info");
}

async function showCustomComponents(ctx: ExtensionContext) {
  // Custom selector with borders
  const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    
    // Border + title
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Custom Select Component")), 1, 0));
    container.addChild(new Spacer(1));
    
    const items = [
      { value: "1", label: "First Item", description: "With description" },
      { value: "2", label: "Second Item" },
      { value: "3", label: "Third Item", description: "Also described" },
    ];
    
    const selectList = new SelectList(items, 5, {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);
    container.addChild(selectList);
    
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • type to filter • enter select • esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    
    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => { 
        selectList.handleInput(data); 
        tui.requestRender(); 
      },
    };
  });
  
  ctx.ui.notify(`Custom select result: ${result || "cancelled"}`, "info");
  await sleep(300);
  
  // Settings/toggles component
  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold("Settings Component")), 1, 1));
    container.addChild(new Spacer(1));
    
    const items = [
      { id: "toggle1", label: "Auto sweep", currentValue: "on", values: ["on", "off"] },
      { id: "toggle2", label: "Gate mode", currentValue: "warn", values: ["block", "warn", "off"] },
      { id: "toggle3", label: "Nudges", currentValue: "smart", values: ["all", "smart", "none"] },
    ];
    
    const settingsList = new SettingsList(
      items,
      8,
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
}

async function showOverlays(ctx: ExtensionContext) {
  // Center overlay (default)
  await ctx.ui.custom((tui, theme, _kb, done) => {
    const box = new Box(2, 1, (s) => theme.bg("toolPendingBg", s));
    box.addChild(new Text(theme.fg("accent", theme.bold("Center Overlay")), 1, 0));
    box.addChild(new Spacer(1));
    box.addChild(new Text("This is centered on screen", 0, 0));
    box.addChild(new Text("Press ESC to close", 0, 0));
    
    return {
      render: (w) => box.render(w),
      invalidate: () => box.invalidate(),
      handleInput: (data) => {
        if (matchesKey(data, Key.escape)) done(undefined);
      },
    };
  }, { overlay: true });
  
  // Right-side panel overlay
  await ctx.ui.custom((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold("Right Panel Overlay")), 1, 0));
    container.addChild(new Spacer(1));
    container.addChild(new Text("Positioned at right-center", 0, 0));
    container.addChild(new Text("Takes 40% width", 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", "ESC to close"), 0, 0));
    
    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        if (matchesKey(data, Key.escape)) done(undefined);
      },
    };
  }, { 
    overlay: true,
    overlayOptions: {
      width: "40%",
      minWidth: 30,
      anchor: "right-center",
    }
  });
  
  // Top-left overlay
  await ctx.ui.custom((tui, theme, _kb, done) => {
    return {
      render: () => [
        theme.bg("toolSuccessBg", theme.fg("success", " ✓ Top-left overlay ")),
        "",
        "This appears at top-left",
        "ESC to close",
      ],
      invalidate: () => {},
      handleInput: (data) => {
        if (matchesKey(data, Key.escape)) done(undefined);
      },
    };
  }, { 
    overlay: true,
    overlayOptions: {
      anchor: "top-left",
      margin: 2,
    }
  });
}

async function showThemeColors(ctx: ExtensionContext) {
  const lines: string[] = [];
  
  // Build color showcase widget
  ctx.ui.setWidget("demo-themes", (tui, theme) => {
    const colors = [
      ["accent", "Accent - primary highlights"],
      ["success", "Success - completions"],
      ["error", "Error - failures"],
      ["warning", "Warning - cautions"],
      ["muted", "Muted - secondary info"],
      ["dim", "Dim - tertiary info"],
    ] as const;
    
    const lines = [
      theme.fg("accent", "┌─ Theme Colors Demo ─"),
      "",
      "Foreground colors:",
      ...colors.map(([c, desc]) => `  ${theme.fg(c, `■ ${c.padEnd(10)}`)} ${desc}`),
      "",
      "Background colors:",
      `  ${theme.bg("selectedBg", "selectedBg")}`,
      `  ${theme.bg("toolSuccessBg", " toolSuccessBg ")}`,
      `  ${theme.bg("toolErrorBg", " toolErrorBg ")}`,
      "",
      "Text styles:",
      `  ${theme.bold("Bold text")}`,
      `  ${theme.italic("Italic text")}`,
      `  ${theme.strikethrough("Strikethrough")}`,
      "",
      theme.fg("accent", "└─────────────────────"),
    ];
    
    return {
      render: () => lines,
      invalidate: () => {},
    };
  });
  
  await waitForEnter(ctx);
  ctx.ui.setWidget("demo-themes", undefined);
}

async function runFullDemo(ctx: ExtensionContext) {
  ctx.ui.notify("🎨 Starting UI Kitchen Sink Demo", "info");
  
  // 1. Status bar progression
  ctx.ui.setStatus("demo", ctx.ui.theme.fg("accent", "● Demo running"));
  
  // 2. Notifications
  await showNotifications(ctx);
  
  // 3. Widgets
  await showWidgets(ctx);
  
  // 4. Dialogs
  await showDialogs(ctx);
  
  // 5. Custom components
  await showCustomComponents(ctx);
  
  // 6. Overlays
  await showOverlays(ctx);
  
  // 7. Theme showcase
  await showThemeColors(ctx);
  
  ctx.ui.setStatus("demo", undefined);
  ctx.ui.notify("✅ Demo complete!", "success");
}

// Helpers
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForEnter(ctx: ExtensionContext): Promise<void> {
  await ctx.ui.input("Press Enter to continue...", "");
}
