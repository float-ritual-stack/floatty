---
name: spec-cold-start
description: Template and components for the Cold-Start briefing action. Produces orientation briefing with status categories.
---

# Cold-Start Briefing Action

Use these components to orient someone new to a page's content.

## Components

- **Heading** (level: 1|2|3, content) — styled heading. Use level 1 for "COLD-START BRIEFING".
- **Chip** (label, color?, icon?) — inline pill for ctx:: metadata (project, mode, date).
- **Row** — horizontal flex container for chip groups. Children are element keys (not inline).
- **StatusLine** (label, color?, content) — colored label prefix. Categories:
  - URGENT / coral — needs immediate attention
  - SHIPPED / green — completed and deployed
  - DOCTRINE / purple — established principles
  - HELD / amber — paused or blocked
- **Paragraph** (content) — body text.
- **BulletList** (items: string[]) — bulleted list.
- **BlockRef** (title, page?, blockId?) — clickable reference.

## Structure

1. Heading(1, "COLD-START BRIEFING") as root, with all others as children
2. Row containing Chips for metadata (project, mode, date) — each Chip is a separate element key
3. StatusLine for each category (URGENT, SHIPPED, DOCTRINE, HELD)
4. Row containing Chips for key links — each Chip is a separate element key

## Example

```spec
{"op":"add","path":"/root","value":"heading"}
{"op":"add","path":"/elements/heading","value":{"type":"Heading","props":{"level":1,"content":"COLD-START BRIEFING"},"children":["meta","urgentLine","shippedLine","doctrineLine","heldLine","body","links"]}}
{"op":"add","path":"/elements/meta","value":{"type":"Row","props":{},"children":["chip-date","chip-project","chip-mode"]}}
{"op":"add","path":"/elements/chip-date","value":{"type":"Chip","props":{"label":"2026-04-08"}}}
{"op":"add","path":"/elements/chip-project","value":{"type":"Chip","props":{"label":"project::floatty"}}}
{"op":"add","path":"/elements/chip-mode","value":{"type":"Chip","props":{"label":"mode::dev"}}}
{"op":"add","path":"/elements/urgentLine","value":{"type":"StatusLine","props":{"label":"URGENT","color":"coral","content":"Description of what needs immediate attention."}}}
{"op":"add","path":"/elements/shippedLine","value":{"type":"StatusLine","props":{"label":"SHIPPED","color":"green","content":"What was completed and deployed."}}}
{"op":"add","path":"/elements/doctrineLine","value":{"type":"StatusLine","props":{"label":"DOCTRINE","color":"purple","content":"Established principles or decisions made."}}}
{"op":"add","path":"/elements/heldLine","value":{"type":"StatusLine","props":{"label":"HELD","color":"amber","content":"What is paused or blocked."}}}
{"op":"add","path":"/elements/body","value":{"type":"Paragraph","props":{"content":"Additional context: key technical details, dependencies, or background needed for orientation."}}}
{"op":"add","path":"/elements/links","value":{"type":"Row","props":{},"children":["chip-link1","chip-link2"]}}
{"op":"add","path":"/elements/chip-link1","value":{"type":"Chip","props":{"label":"key-link-1"}}}
{"op":"add","path":"/elements/chip-link2","value":{"type":"Chip","props":{"label":"key-link-2"}}}
```
