/**
 * ExportValidation.tsx - Non-blocking warnings panel for export
 *
 * FLO-349: Shows validation warnings before export but NEVER blocks it.
 * User can always "Export Anyway" to access their data.
 */

import { For, Show, createMemo } from 'solid-js';
import {
  groupWarnings,
  WARNING_LABELS,
  type ValidationWarning,
  type WarningType,
} from '../lib/validation';

interface ExportValidationProps {
  warnings: ValidationWarning[];
  onExport: () => void;
  onCancel: () => void;
}

export function ExportValidation(props: ExportValidationProps) {
  const grouped = createMemo(() => groupWarnings(props.warnings));
  const warningTypes = createMemo(() => [...grouped().keys()] as WarningType[]);

  return (
    <div
      class="export-validation-backdrop"
      role="dialog"
      aria-label="Export validation warnings"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onCancel();
      }}
    >
      <div class="export-validation-panel">
        <h3 class="export-validation-title">Export Warnings</h3>
        <p class="export-validation-subtitle">
          {props.warnings.length} issue{props.warnings.length !== 1 ? 's' : ''} found. You can still export.
        </p>

        <div class="export-validation-warnings">
          <For each={warningTypes()}>
            {(type) => {
              const items = () => grouped().get(type) || [];
              return (
                <div class="export-validation-group">
                  <div class="export-validation-group-header">
                    <span>{WARNING_LABELS[type]}</span>
                    <span class="export-validation-count">{items().length}</span>
                  </div>
                  <ul class="export-validation-list">
                    <For each={items().slice(0, 5)}>
                      {(warning) => (
                        <li class="export-validation-item">{warning.message}</li>
                      )}
                    </For>
                    <Show when={items().length > 5}>
                      <li class="export-validation-item export-validation-more">
                        …and {items().length - 5} more
                      </li>
                    </Show>
                  </ul>
                </div>
              );
            }}
          </For>
        </div>

        <div class="export-validation-actions">
          <button
            class="export-validation-btn export-validation-btn-cancel"
            onClick={() => props.onCancel()}
          >
            Cancel
          </button>
          <button
            class="export-validation-btn export-validation-btn-export"
            onClick={() => props.onExport()}
          >
            Export Anyway
          </button>
        </div>
      </div>
    </div>
  );
}
