---
name: spec-summarize
description: Template and components for the Summarize analysis action. Produces stat overview, narrative, and session arc.
---

# Summarize Action

Use these components to build a structured summary.

## Components

- **SectionLabel** (label, color?, icon?) — section header. Colors: cyan, magenta, coral, amber, green, purple, dim. Icons: FileText, Clock, BarChart3.
- **StatPill** (label, value, color?) — numeric stat counter (e.g. label:"blocks", value:"539").
- **Paragraph** (content) — body text. Renders **bold** and `code` inline.
- **TimelineEvent** (time, label, color?) — timeline dot for session arcs.
- **Chip** (label, color?, icon?) — inline pill for decisions, tags.
- **Section** (title) — collapsible grouping. Has children slot.
- **Heading** (level: 1|2|3, content) — styled heading.
- **BulletList** (items: string[]) — bulleted list.

## Structure

1. SectionLabel("Summary", cyan, FileText) containing:
   - Section("") with StatPill row for key metrics
   - Paragraph for narrative overview
2. SectionLabel("Session Arc", dim, Clock) containing:
   - TimelineEvent for each session/phase
3. Chip for key decisions or tags

## Example

```spec
{"op":"add","path":"/root","value":"main"}
{"op":"add","path":"/elements/main","value":{"type":"SectionLabel","props":{"label":"Summary","color":"cyan","icon":"FileText"},"children":["stats","overview","arc"]}}
{"op":"add","path":"/elements/stats","value":{"type":"Section","props":{"title":""},"children":["s1","s2","s3"]}}
{"op":"add","path":"/elements/s1","value":{"type":"StatPill","props":{"label":"blocks","value":"539","color":"cyan"}}}
{"op":"add","path":"/elements/s2","value":{"type":"StatPill","props":{"label":"sessions","value":"3","color":"magenta"}}}
{"op":"add","path":"/elements/s3","value":{"type":"StatPill","props":{"label":"issues","value":"4","color":"amber"}}}
{"op":"add","path":"/elements/overview","value":{"type":"Paragraph","props":{"content":"Dense shipping day split between pharmacy rent and float infrastructure."}}}
{"op":"add","path":"/elements/arc","value":{"type":"SectionLabel","props":{"label":"Session Arc","color":"dim","icon":"Clock"},"children":["t1","t2"]}}
{"op":"add","path":"/elements/t1","value":{"type":"TimelineEvent","props":{"time":"10:33","label":"brain boot — pharmacy","color":"amber"}}}
{"op":"add","path":"/elements/t2","value":{"type":"TimelineEvent","props":{"time":"14:30","label":"floatty explorer v1","color":"cyan"}}}
```
