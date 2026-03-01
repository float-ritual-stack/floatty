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
import type { DoorViewProps } from './doorTypes';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface DoorEntry {
  view: Accessor<Component<DoorViewProps>>;
  setView: (v: Component<DoorViewProps>) => void;
  settings: Accessor<Record<string, unknown>>;
  setSettings: (s: Record<string, unknown>) => void;
}

// ═══════════════════════════════════════════════════════════════
// REGISTRY CLASS
// ═══════════════════════════════════════════════════════════════

export class DoorRegistry {
  private doors = new Map<string, DoorEntry>();

  /** Register a new door view + settings. Creates signal pair. */
  register(
    doorId: string,
    view: Component<DoorViewProps>,
    settings: Record<string, unknown> = {}
  ): void {
    const [viewSig, setView] = createSignal<Component<DoorViewProps>>(view);
    const [settingsSig, setSettings] = createSignal<Record<string, unknown>>(settings);
    this.doors.set(doorId, {
      view: viewSig,
      setView: (v) => setView(() => v),  // Thunk wrap — prevents SolidJS unwrapping
      settings: settingsSig,
      setSettings,
    });
  }

  /** Update an existing door (hot reload path). Falls back to register if missing. */
  update(
    doorId: string,
    view: Component<DoorViewProps>,
    settings: Record<string, unknown> = {}
  ): void {
    const entry = this.doors.get(doorId);
    if (entry) {
      entry.setView(view);
      entry.setSettings(settings);
    } else {
      this.register(doorId, view, settings);
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

  /** Remove a door from the registry */
  unregister(doorId: string): void {
    this.doors.delete(doorId);
  }

  /** Clear all entries (HMR cleanup) */
  clear(): void {
    this.doors.clear();
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
