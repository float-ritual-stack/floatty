/**
 * Session Garden door — BBS document viewer built on @json-render/solid
 *
 * Exports:
 *   - door, meta         — door system integration
 *   - bbsCatalog          — catalog for LLM spec generation
 *   - registry            — component registry for Renderer
 *   - Entry               — entry type
 *   - DEMO_ENTRIES        — sample data
 *   - Components          — individual components for custom registries
 */

export { door, meta, type Entry } from './session-garden';
export { bbsCatalog } from './catalog';
export { registry } from './registry';
export { DEMO_ENTRIES } from './demo-data';

// Re-export components for registries that want to cherry-pick
export {
  DocLayout,
  NavBrand,
  NavSection,
  NavItem,
  NavFooter,
  EntryHeader,
  EntryBody,
  Ellipsis,
  TagBar,
  TagChip,
  RefSection,
  RefCard,
  Breadcrumb,
  Stack,
  Text,
  Divider,
  TuiPanel,
  TuiStat,
  BarChart,
  BarItemComponent,
  DataBlock,
  ShippedItem,
  WikilinkChip,
  BacklinksFooter,
  PatternCard,
  injectBodyStyles,
} from './components';
