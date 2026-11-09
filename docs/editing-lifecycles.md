# Editing lifecycles

The SVG DOM remains the source of truth. An edit's completion rules depend on the
operation; there is no universal rebuild/history/notify transaction.

| Workflow | Live changes | Completion | Exit behavior |
| --- | --- | --- | --- |
| Pointer move (`tools/select.ts`) | Translate gesture targets; update overlays while interactive | `AppState.commitMove` reparents moved shapes and records history; zero-delta moves record nothing | Mouse-up clears gesture state, guides, and interactive mode, then refreshes panels |
| Keyboard nudge (`tools/nudge-session.ts`) | Resolve movable selection for each press; translate through SelectTool's coordinate-aware helper; synchronize moved frames | First press opens an undo entry; repeats accelerate; the quiet-period timer calls `commitMove` with amendment | Fresh non-repeat presses finalize the preceding run; tool deactivation finalizes the run and clears its HUD timer |
| Pointer resize (`tools/select.ts`) | Recalculate from geometry captured at gesture start | Bake eligible transforms, rebuild if needed, and save history; never use move reparenting | Mouse-up clears resize snapshots and interactive state |
| Node editing (`tools/node-edit.ts`) | Edit path-session geometry and render it live | Dirty geometry commits through `commitPathEdit`; keyboard node nudges commit per press | Mouse-up ends interactive mode before committing; deactivation commits dirty geometry |
| Round Corners preview (`core/corners.ts`) | Preserve original markup and calculate each preview from captured geometry | Commit keeps changed paths and restores unchanged originals; only real changes record history | Cancel restores original elements and rebuilds; live previews gate session persistence |
| Property controls (`ui/dom.ts`, `ui/properties.ts`) | Controls distinguish live input from committed values; typed scrub fields wait for commit | `change` records the edit using the control's existing target/geometry rules | Canvas presses commit fields before selection changes |

## First extraction: keyboard nudge

`NudgeSession` owns acceleration, the open-run flag, commit/HUD timers, and
interactive-mode cleanup. Its `NudgeHost` supplies only selection, movement,
frame synchronization, history/commit, rendering, and HUD operations. It never
receives an AppState reference. SelectTool retains keyboard routing, lock
filtering, and the shared coordinate-aware translation helper.

This extraction preserves the existing timings (220 ms commit, 1000 ms HUD),
per-tap undo entries, held-key amendment, and selection resolution on each press.
It does not change target ownership or introduce generic gesture cancellation.
History's post-undo amendment guard remains authoritative.

Future extractions should start with an existing cohesive lifecycle and retain
its distinct coordinate, preview, and undo rules. Share calculations only when
the input coordinate spaces and captured/live geometry semantics match.
