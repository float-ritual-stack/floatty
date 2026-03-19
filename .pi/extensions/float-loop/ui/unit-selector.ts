/**
 * Unit Selector Overlay
 *
 * Shows current unit with entry/exit checklists.
 * Allows marking items complete.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Text, Spacer, matchesKey, Key } from "@mariozechner/pi-tui";

interface ChecklistItem {
  label: string;
  checked: boolean;
}

interface UnitData {
  id: string;
  name: string;
  status: "pending" | "in_progress" | "complete";
  entry: ChecklistItem[];
  exit: ChecklistItem[];
}

export async function showUnitSelector(
  ctx: ExtensionContext,
  unit: UnitData
): Promise<void> {
  await ctx.ui.custom((tui, theme, _kb, done) => {
    const container = new Container();
    let selectedIndex = 0;
    let inExitSection = false;

    const allItems = [
      ...unit.entry.map((i) => ({ ...i, section: "entry" as const })),
      { label: "--- EXIT CHECKLIST ---", checked: false, section: "separator" as const },
      ...unit.exit.map((i) => ({ ...i, section: "exit" as const })),
    ];

    function renderContent(): string[] {
      const lines: string[] = [];

      // Header
      lines.push(theme.fg("accent", `┌─ Unit ${unit.id}: ${unit.name} ─${"─".repeat(30)}┐`));
      lines.push("");

      // Checklist items
      allItems.forEach((item, idx) => {
        const isSelected = idx === selectedIndex;
        const prefix = isSelected ? theme.fg("accent", "> ") : "  ";

        if (item.section === "separator") {
          lines.push(theme.fg("dim", item.label));
          return;
        }

        const checkbox = item.checked
          ? theme.fg("success", "☑ ")
          : theme.fg("dim", "☐ ");

        const text = item.checked ? theme.strikethrough(item.label) : item.label;
        const styled = isSelected ? theme.fg("accent", text) : text;

        lines.push(prefix + checkbox + styled);
      });

      lines.push("");
      lines.push(theme.fg("dim", "↑↓ navigate • space toggle • q close"));
      lines.push(theme.fg("accent", "└" + "─".repeat(50) + "┘"));

      return lines;
    }

    const component = {
      render(_width: number): string[] {
        return renderContent();
      },

      invalidate(): void {},

      handleInput(data: string): void {
        if (matchesKey(data, Key.up) && selectedIndex > 0) {
          selectedIndex--;
          if (allItems[selectedIndex]?.section === "separator") selectedIndex--;
          tui.requestRender();
        } else if (matchesKey(data, Key.down) && selectedIndex < allItems.length - 1) {
          selectedIndex++;
          if (allItems[selectedIndex]?.section === "separator") selectedIndex++;
          tui.requestRender();
        } else if (data === " ") {
          // Toggle checkbox
          const item = allItems[selectedIndex];
          if (item && item.section !== "separator") {
            item.checked = !item.checked;
            tui.requestRender();
          }
        } else if (matchesKey(data, Key.escape) || data === "q") {
          done(undefined);
        }
      },
    };

    return component;
  });
}
