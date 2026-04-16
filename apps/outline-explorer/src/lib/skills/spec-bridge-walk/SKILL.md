---
name: spec-bridge-walk
description: Template and components for the Bridge Walk analysis action. Produces numbered observations with cross-references and optional link graph.
---

# Bridge Walk Action

Use these components to present numbered observations about connections.

## Components

- **SectionLabel** (label, color?, icon?) — section header. Use color:"purple", icon:"Compass".
- **ObservationCard** (number, title, body, severity?: "surprising"|"structural"|"gap"|"thread"|"meta", links?: string[]) — expandable numbered observation. links are wikilink targets.
- **LinkGraph** (nodes: [{id, label, color?, weight?, center?, ring?, type?}], edges: [[fromId, toId]]) — SVG radial graph showing page neighborhoods.
- **Paragraph** (content) — body text.
- **BlockRef** (title, page?, blockId?) — clickable wikilink reference.
- **WalkChip** (page, reason?) — walk suggestion chip.

## Structure

1. SectionLabel("Bridge Walk — N observations", purple, Compass) containing:
   - ObservationCard for each observation (numbered 1-N)
2. Optional LinkGraph for connection structure
3. WalkChip suggestions at the end

## Example

```spec
{"op":"add","path":"/root","value":"main"}
{"op":"add","path":"/elements/main","value":{"type":"SectionLabel","props":{"label":"Bridge Walk — 3 observations","color":"purple","icon":"Compass"},"children":["o1","o2","o3"]}}
{"op":"add","path":"/elements/o1","value":{"type":"ObservationCard","props":{"number":"1","title":"Recursive self-documentation","body":"The graph is being walked while it's being written.","severity":"surprising","links":["Claudeception","consciousness-tech"]}}}
{"op":"add","path":"/elements/o2","value":{"type":"ObservationCard","props":{"number":"2","title":"Ghost edge to FLO-573","body":"Issue exists with linear:: backlink but zero visible content.","severity":"gap","links":["FLO-573","FLO-574"]}}}
{"op":"add","path":"/elements/o3","value":{"type":"ObservationCard","props":{"number":"3","title":"Vocabulary as leverage","body":"GRAPH_PREAMBLE (150 tokens) outperformed doubling serialization depth.","severity":"structural","links":["FLO-575"]}}}
```
