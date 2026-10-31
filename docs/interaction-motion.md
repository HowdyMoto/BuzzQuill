# Interaction motion

Motion explains an action; it never delays one. The shared tokens live in the
Interaction feedback section of `src/style.css`. Use `ui/feedback.ts` for one-shot
feedback and the existing modal/toast/loading primitives for lifecycle feedback.

| Beat | Token | Use |
| --- | --- | --- |
| Press | `--fx-fast` (90ms) | Immediate tactile contrast; no moving toolbar targets |
| Respond | `--fx` (160ms) | Hover, focus, input borders and menu reveals |
| Reveal | `--fx-enter` (220ms) | Dialogs, palettes, color picker, disclosure, tabs |
| Settle | `--fx-settle` (320ms) | Confirmation wash and small success pop |

`--fx-ease` is a quick ease-out. `--fx-spring` has one restrained overshoot.
Accent means interaction; green plus a check means completed work; warning
messages stay legible without an exaggerated shake. Keep bursts small and reserve
them for successful exports/saves. Never celebrate a click before work completes.

## Coverage and boundaries

- Tools and compact actions: shared pulse, including keyboard tool selection.
- Menus/context menus, tooltips, dialogs, command palette and color picker:
  quick entrances; dismissal and focus restoration remain immediate.
- Panels, layer creation and new tabs: animate only the state transition, never
  repeated panel rendering. Rows and scrollable toolbar items don't shrink.
- Switches: a small thumb settle; fields/selects: a ring on valid commit.
- Local and Drive saves: the owning tab says Saving while work is pending.
  Its unsaved mark remains until the saved revision is confirmed. Failure/cancel
  always clears progress, and changing tabs never moves it to another document.
- Loading: named indeterminate progress; reduced motion uses a static filled
  track instead of a bar that could stop offscreen.
- Notifications: compact success check, calm warning, readable text; timers pause
  for pointer hover AND keyboard focus. Export confirmation restores original DOM
  nodes so child listeners/focus semantics aren't destroyed by an HTML reset.

Respect `prefers-reduced-motion` at both CSS and JS boundaries. Keep status text,
checks, focus rings and selected states; remove bounce, bursts and travel. Don't
animate artwork, drag geometry, resize handles or canvas coordinates. No blanket
mutation observer: rendered UI churn must not trigger a celebration.

Validation: `test/interaction-feedback.spec.ts`, save ownership and Drive tests,
modal/a11y/context-bar suites, plus `scripts/ui-walkthrough.mjs` for real pointer
interaction and screenshots.
