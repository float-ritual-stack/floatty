# Accessibility Baseline (Proactive)

Build accessibility in while writing UI components — don't wait for review
findings to bolt it on. Current models know the ARIA/focus/motion mechanics;
this rule exists for the DISCIPLINE, plus floatty's specifics:

- **Landmarks**: `role` on main layout regions (main / complementary sidebar /
  navigation tab bar / contentinfo status bar).
- **Interactive elements**: `aria-label` on icon-only buttons ("Close tab
  {title}"), `aria-pressed` on toggles, `role="button"` + `tabindex="0"` +
  keyboard handler on custom controls.
- **Dynamic status**: `aria-live="polite"` (errors only get `assertive`).
- **Focus**: every interactive element gets a visible `:focus-visible` outline
  using `var(--color-accent)`.
- **Motion**: honor `@media (prefers-reduced-motion: reduce)`.
- **Color is never the only signal** — pair red/green state with an icon or label.

This is baseline, not gold-plating. Build it in, don't bolt it on.
