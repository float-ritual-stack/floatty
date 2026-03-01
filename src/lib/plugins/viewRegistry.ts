/**
 * View Registry
 *
 * Maps outputType strings to SolidJS components for rendering output blocks.
 * Plugins register their view components here; BlockItem.tsx looks them up.
 *
 * This replaces the hardcoded `<Show when={outputType === 'daily-view'>` pattern
 * with a registry-driven approach.
 */

import type { Component } from 'solid-js';
import type { OutputViewProps } from './types';

// ═══════════════════════════════════════════════════════════════
// REGISTRY
// ═══════════════════════════════════════════════════════════════

const views = new Map<string, Component<OutputViewProps>>();

/**
 * Register a view component for an outputType.
 *
 * @param outputType - The outputType string (e.g., 'daily-view', 'search-results')
 * @param component - SolidJS component to render
 */
export function registerView(outputType: string, component: Component<OutputViewProps>): void {
  if (views.has(outputType)) {
    console.warn(`[viewRegistry] Overwriting existing view for outputType "${outputType}"`);
  }
  views.set(outputType, component);
}

/**
 * Look up a view component for an outputType.
 *
 * @returns Component if registered, undefined otherwise
 */
export function getView(outputType: string | undefined): Component<OutputViewProps> | undefined {
  if (!outputType) return undefined;
  return views.get(outputType);
}

/**
 * Check if any view is registered for an outputType.
 */
export function hasView(outputType: string | undefined): boolean {
  if (!outputType) return false;
  return views.has(outputType);
}

/**
 * Get all registered outputTypes (for debugging).
 */
export function getRegisteredViewTypes(): string[] {
  return Array.from(views.keys());
}

/**
 * Unregister a view component.
 *
 * @returns true if the view was found and removed
 */
export function unregisterView(outputType: string): boolean {
  return views.delete(outputType);
}

/**
 * Clear all registered views (for HMR cleanup).
 */
export function clearViews(): void {
  views.clear();
}
