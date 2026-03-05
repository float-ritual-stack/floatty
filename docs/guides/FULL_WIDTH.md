# Full-Width Block Mode

Break a block's output out of indentation to use the full pane width.

## Quick Start

1. Focus any block that has output (eval result, iframe, door, search results)
2. Press `⌘⇧F` (Cmd+Shift+F)
3. Output stretches edge-to-edge. Block bullet/content stays indented.
4. Press `⌘⇧F` again to toggle off.

## What It Does

```text
NORMAL (depth 2):
│  │  ├─ func:: chart
│  │  │  ┌──────────────────┐
│  │  │  │  iframe (narrow)  │
│  │  │  └──────────────────┘

FULL-WIDTH (⌘⇧F):
│  │  ├─ func:: chart                    ← stays indented
┌────────────────────────────────────────┐
│  iframe (full pane width)              │  ← breaks out
└────────────────────────────────────────┘
```

The block itself (bullet, prefix, content) stays in the tree — you keep your outline context. Only the output area expands.

## When To Use

- **Iframes**: dashboards, viewers, embedded tools cramped at depth 3+
- **Eval results**: tables, charts, or any wide output
- **Search results**: more room for result previews

## How It Works

- State is per-block, per-pane (like collapse). Same block can be full-width in one pane and normal in another.
- CSS `calc()` pulls the output flush with the outliner container edges using negative margins.
- A subtle accent border on the left marks full-width blocks.

## Combining With Other Features

- **Collapse** (`⌘.`): collapse hides output entirely, full-width widens it. Independent toggles.
- **Full-pane zoom** (`⌘Enter`): replaces the entire pane with the iframe. Full-width keeps the outline visible.
- **Split panes**: full-width respects pane boundaries. Each pane's blocks toggle independently.

## Examples

```text
eval:: 2 + 2
→ Shows "4" inline. ⌘⇧F widens the result display.

func:: weather
body:: return "https://weather.example.com"
weather:: london
→ Iframe appears indented. ⌘⇧F stretches it edge-to-edge.
```
