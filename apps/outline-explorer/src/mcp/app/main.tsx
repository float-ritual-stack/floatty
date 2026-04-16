import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { useJsonRenderApp } from "@json-render/mcp/app";
import { ExplorerRenderer } from "../../lib/catalog/explorer-renderer";
import "./tailwind.css";

function App() {
  const { spec, loading, error } = useJsonRenderApp();

  if (error) {
    return (
      <div className="p-4 text-coral font-mono text-xs">
        Error: {error.message}
      </div>
    );
  }

  if (!spec) {
    return (
      <div className="p-4 text-muted font-mono text-xs">
        waiting for spec...
      </div>
    );
  }

  return <ExplorerRenderer spec={spec} loading={loading} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
