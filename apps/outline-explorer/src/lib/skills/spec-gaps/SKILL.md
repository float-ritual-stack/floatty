---
name: spec-gaps
description: Template and components for the Gaps analysis action. Produces gap findings with type badges and optional risk matrix.
---

# Gaps Action

Use these components to present gap findings.

## Components

- **SectionLabel** (label, color?, icon?) — section header. Use color:"coral", icon:"Zap".
- **StatPill** (label, value, color?) — gap type counts.
- **GapItem** (description, severity?: "info"|"warning"|"critical", gapType?: "stub"|"orphan"|"empty"|"asymmetric"|"unanswered", evidence?, target?) — gap finding with type badge and evidence.
- **RiskMatrix** (items: [{label, severity: "high"|"medium"|"low", impact: "structural"|"content"|"cosmetic"}]) — severity x impact grid.
- **Section** (title) — collapsible grouping.
- **Paragraph** (content) — body text.

## Structure

1. SectionLabel("Gap Analysis", coral, Zap) containing:
   - Section("") with StatPill row for gap type counts
   - GapItem for each finding
2. Optional RiskMatrix for complex audits
