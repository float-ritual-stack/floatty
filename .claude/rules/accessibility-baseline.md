# Accessibility Baseline (Proactive)

When writing UI components, apply these patterns as baseline hygiene - don't wait for review findings.

## ARIA Landmarks

Add `role` attributes to main layout regions:
```tsx
<div role="main">...</div>           // Primary content area
<aside role="complementary">...</aside>  // Sidebar
<nav role="navigation">...</nav>     // Tab bar, breadcrumbs
<footer role="contentinfo">...</footer>  // Status bar
```

## Interactive Elements

- Buttons need `aria-label` when icon-only or text isn't self-describing
- Close buttons: `aria-label="Close tab {title}"`
- Toggle buttons: `aria-pressed={isActive}`
- Custom controls: `role="button"` + `tabindex="0"` + keyboard handler

## Status Updates

Use `aria-live` for dynamic content:
```tsx
<span aria-live="polite">{pendingCount} parsing...</span>
```

- `polite` = announce when user is idle (most cases)
- `assertive` = interrupt immediately (errors only)

## Focus Indicators

All interactive elements need visible `:focus-visible`:
```css
.interactive:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
```

## Motion

Respect user preferences:
```css
@media (prefers-reduced-motion: reduce) {
  .animated-element {
    animation: none;
    transition: none;
  }
}
```

## Color

Never use color alone for state:
- Red/green status → add icon or text label
- Error states → add icon, not just red border

---

This is baseline, not gold-plating. Build it in, don't bolt it on.
