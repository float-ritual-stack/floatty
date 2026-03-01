/**
 * EvalOutput — Dynamic viewer dispatch for eval:: block results
 *
 * Uses SolidJS <Dynamic> to pick the right viewer based on result type.
 * Viewers: value (toString), json (pretty-print), table (array→table), error (red).
 */

import { Dynamic, type Component } from 'solid-js/web';
import type { EvalResult } from '../lib/evalEngine';

// ═══════════════════════════════════════════════════════════════
// VIEWERS
// ═══════════════════════════════════════════════════════════════

interface ViewerProps {
  data: unknown;
}

const ValueViewer: Component<ViewerProps> = (props) => (
  <div class="eval-output-value">{String(props.data)}</div>
);

const JsonViewer: Component<ViewerProps> = (props) => (
  <pre class="eval-output-json">{JSON.stringify(props.data, null, 2)}</pre>
);

const TableViewer: Component<ViewerProps> = (props) => {
  const rows = () => props.data as Record<string, unknown>[];
  const cols = () => {
    const r = rows();
    if (!r.length) return [];
    return Object.keys(r[0]);
  };

  return (
    <table class="eval-output-table">
      <thead>
        <tr>
          {cols().map((col) => <th>{col}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows().map((row) => (
          <tr>
            {cols().map((col) => <td>{String(row[col] ?? '')}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const ErrorViewer: Component<ViewerProps> = (props) => (
  <div class="eval-output-error">{String(props.data)}</div>
);

// ═══════════════════════════════════════════════════════════════
// VIEWER REGISTRY
// ═══════════════════════════════════════════════════════════════

const EVAL_VIEWERS: Record<string, Component<ViewerProps>> = {
  value: ValueViewer,
  json: JsonViewer,
  table: TableViewer,
  error: ErrorViewer,
};

// ═══════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════

interface EvalOutputProps {
  output: EvalResult;
}

export function EvalOutput(props: EvalOutputProps) {
  const viewer = () => EVAL_VIEWERS[props.output.type] ?? EVAL_VIEWERS.value;
  return (
    <div class="eval-output">
      <Dynamic component={viewer()} data={props.output.data} />
    </div>
  );
}
