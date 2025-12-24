# Product Guidelines - Floatty

## Prose Style
- **Minimalist and Direct:** Documentation and in-app text should be concise, avoiding fluff. Let the UI and performance speak for themselves. Focus on actionable information.

## Design Principles
- **High Density:** Maximize information density. The interface is designed for power users who benefit from seeing extensive context and controls simultaneously.
- **Performance-First:** Prioritize responsiveness, low latency, and smooth transitions.
  - **Technical Implication:** Use techniques like `display: none` instead of unmounting components (e.g., `<Show>` in SolidJS) to preserve state and avoid re-initialization costs, especially for heavy components like terminals.
