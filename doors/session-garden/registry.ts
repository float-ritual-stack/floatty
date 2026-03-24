/**
 * BBS Document Viewer registry — wires catalog to components
 *
 * Usage:
 *   import { registry, bbsCatalog } from './registry';
 *   <Renderer spec={spec} registry={registry} />
 */

import { defineRegistry } from '@json-render/solid';
import { bbsCatalog } from './catalog';
import {
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

// Inject styles when registry is imported
injectBodyStyles();

export const { registry, handlers } = defineRegistry(bbsCatalog, {
  components: {
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
    BarItem: BarItemComponent,
    DataBlock,
    ShippedItem,
    WikilinkChip,
    BacklinksFooter,
    PatternCard,
  },
  actions: {
    selectEntry: async () => {},
    filterTag: async () => {},
    goBack: async () => {},
    navigate: async () => {},
    scrollTo: async () => {},
  },
});

export { bbsCatalog };
