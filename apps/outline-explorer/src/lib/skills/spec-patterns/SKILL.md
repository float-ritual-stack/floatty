---
name: spec-patterns
description: Template and components for the Patterns analysis action. Produces pattern clusters and theme cards.
---

# Patterns Action

Use these components to present discovered patterns and themes.

## Components

- **SectionLabel** (label, color?, icon?) — section header. Use color:"magenta", icon:"Sparkles".
- **PatternCard** (label, description, confidence?: "high"|"medium"|"low") — pattern/theme card.
- **PatternCluster** (name, color?, instances: string[], connections?: string[]) — cluster visualization with instances and cross-connections.
- **Paragraph** (content) — body text.
- **ConfidenceDot** (level: "high"|"medium"|"low"|"partial") — inline confidence indicator.

## Structure

1. SectionLabel("Patterns — N found", magenta, Sparkles) containing:
   - PatternCluster for each thematic cluster
   - OR PatternCard for individual patterns
2. Paragraph for synthesis/interpretation
