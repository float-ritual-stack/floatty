# echoCopy:: - Materialize Render Output as Blocks

Extracts the readable content from a render door output block and creates it as plain markdown blocks in the outline. One keystroke to get the flat version of any rich interactive view.

## Usage

```
echoCopy:: [[c229bfa9]]        # short hash (8+ hex chars)
echoCopy:: [[My Page]]          # page name
echoCopy:: c229bfa9de12...      # bare UUID or prefix
```

Press Enter to execute. Child blocks appear immediately.

## What It Does

1. Resolves the block reference (short hash, page name, or UUID)
2. Reads `metadata.renderedMarkdown` from the target block
3. Falls back to flattening `output.data.spec.elements` if metadata not yet populated
4. Parses the markdown into a block tree (headings → parents, lists → children)
5. Creates the blocks as children of the echoCopy block

No LLM call. No network request. Pure local read + parse.

## When To Use

- Render door produced a rich interactive view (tabs, cards, stats) but you want the content as editable outline blocks
- You want to reference, annotate, or restructure content that's locked inside a JSON spec
- Quick extraction of structured content from any door output

## Component → Markdown Mapping

| Spec Component | Markdown Output |
|----------------|----------------|
| EntryHeader | `## Title (date) — author` |
| EntryBody | Verbatim markdown |
| PatternCard | `### Title [type]\n content` |
| QuoteBlock | `> text\n> — attribution` |
| Text | Content as-is |
| Code | Fenced code block |
| StatsBar / Metric | `- **label**: value` |
| WikilinkChip | `[[target]]` |
| BacklinksFooter | Inbound/outbound link lists |
| Nav elements | Skipped (chrome) |

## Error Cases

| Condition | Message |
|-----------|---------|
| No reference provided | `echoCopy:: error — no block reference` |
| Block not found | `echoCopy:: error — block not found: ref` |
| No rendered content | `echoCopy:: error — no rendered content on [[hash]]` |
| Empty after parsing | `echoCopy:: error — empty rendered content` |

## Example

```
render:: ai Tell me about the HTTM pattern
  → [interactive view with tabs, pattern cards, quotes]

echoCopy:: [[a1b2c3d4]]
  → # HTTM Origin Story
    ## Background
      This is the body content...
    ### Pattern: Event Sourcing [architectural]
      Content here...
    > "The event is the fact" — Greg Young
```

## Re-execution

Running echoCopy on the same block again creates duplicate children. Use Cmd+Z to undo if needed.
