"use client";

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  onRetry?: () => void;
}

interface State {
  error: Error | null;
}

export class ViewErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-[11px] font-mono text-center max-w-sm">
            <div className="text-coral font-bold mb-2">view crashed</div>
            <pre className="text-dim whitespace-pre-wrap mb-3 text-left bg-surface rounded p-3">
              {this.state.error.message}
            </pre>
            <button
              onClick={() => {
                this.setState({ error: null });
                this.props.onRetry?.();
              }}
              className="px-3 py-1 bg-surface border border-border rounded text-text hover:border-cyan transition-colors"
            >
              retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
