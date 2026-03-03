/**
 * Door Registry — Signal-Backed View Component Registry
 *
 * Pattern A: each door gets its own signal pair for view and settings.
 * This is load-bearing for Unit 7.0 (hot reload) — when update() calls
 * the signal setter, <Dynamic> re-renders automatically.
 *
 * Critical: setView(() => view) — wrap component in thunk to prevent
 * SolidJS createSignal from unwrapping it as a getter.
 */

import { createSignal } from 'solid-js';
import type { Component, Accessor } from 'solid-js';
import type { DoorViewProps, DoorMeta } from './doorTypes';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface DoorEntry {
  view: Accessor<Component<DoorViewProps>>;
  setView: (v: Component<DoorViewProps>) => void;
  settings: Accessor<Record<string, unknown>>;
  setSettings: (s: Record<string, unknown>) => void;
  meta: DoorMeta;
}

// ═══════════════════════════════════════════════════════════════
// REGISTRY CLASS
// ═══════════════════════════════════════════════════════════════

export class DoorRegistry {
  private doors = new Map<string, DoorEntry>();
  /** Structural version — bumps on register/unregister so sidebar can react */
  private version: Accessor<number>;
  private setVersion: (v: number) => void;
  private versionCounter = 0;

  constructor() {
    const [version, setVersion] = createSignal(0);
    this.version = version;
    this.setVersion = setVersion;
  }

  private bumpVersion(): void {
    this.setVersion(++this.versionCounter);
  }

  /** Register a new door view + settings. Creates signal pair. */
  register(
    doorId: string,
    view: Component<DoorViewProps>,
    settings: Record<string, unknown> = {},
    meta?: DoorMeta,
  ): void {
    const [viewSig, setView] = createSignal<Component<DoorViewProps>>(view);
    const [settingsSig, setSettings] = createSignal<Record<string, unknown>>(settings);
    this.doors.set(doorId, {
      view: viewSig,
      setView: (v) => setView(() => v),  // Thunk wrap — prevents SolidJS unwrapping
      settings: settingsSig,
      setSettings,
      meta: meta ?? { id: doorId, name: doorId },
    });
    // Notify sidebar signal of structural change
    this.bumpVersion();
  }

  /** Update an existing door (hot reload path). Falls back to register if missing. */
  update(
    doorId: string,
    view: Component<DoorViewProps>,
    settings: Record<string, unknown> = {},
    meta?: DoorMeta,
  ): void {
    const entry = this.doors.get(doorId);
    if (entry) {
      entry.setView(view);
      entry.setSettings(settings);
      if (meta) {
        entry.meta = meta;
        this.bumpVersion();
      }
    } else {
      this.register(doorId, view, settings, meta);
    }
  }

  /** Get view component for a door. Returns signal accessor (tracked by SolidJS). */
  getView(doorId: string): Component<DoorViewProps> | undefined {
    return this.doors.get(doorId)?.view();
  }

  /** Get settings for a door. Returns signal accessor (tracked by SolidJS). */
  getSettings(doorId: string): Record<string, unknown> {
    return this.doors.get(doorId)?.settings() ?? {};
  }

  /** Check if a door is registered */
  has(doorId: string): boolean {
    return this.doors.has(doorId);
  }

  /** Get meta for a door */
  getMeta(doorId: string): DoorMeta | undefined {
    return this.doors.get(doorId)?.meta;
  }

  /**
   * Get sidebar-eligible door IDs with their meta.
   * Reading this.version inside a createMemo makes it reactive to structural changes.
   */
  getSidebarDoors(): { id: string; meta: DoorMeta }[] {
    // Touch version signal so callers re-run on register/unregister
    this.version();
    const result: { id: string; meta: DoorMeta }[] = [];
    for (const [id, entry] of this.doors) {
      if (entry.meta.sidebarEligible) {
        result.push({ id, meta: entry.meta });
      }
    }
    return result;
  }

  /** Remove a door from the registry */
  unregister(doorId: string): void {
    this.doors.delete(doorId);
    this.bumpVersion();
  }

  /** Clear all entries (HMR cleanup) */
  clear(): void {
    this.doors.clear();
    this.bumpVersion();
  }

  /** Get all registered door IDs (debugging) */
  getRegisteredDoorIds(): string[] {
    return Array.from(this.doors.keys());
  }
}

// ═══════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════

export const doorRegistry = new DoorRegistry();
