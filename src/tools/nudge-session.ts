import type { ShapeData } from '../core/types';

/** Selection geometry and document commits remain owned by SelectTool/AppState. */
export interface NudgeHost {
  movableSelection(): ShapeData[];
  translateElement(element: SVGElement, dx: number, dy: number): void;
  syncFrames(): void;
  saveHistory(): void;
  /** Reparent moved shapes and amend the run's existing undo entry. */
  commitMove(): void;
  setInteractive(on: boolean): void;
  onChange(): void;
  showHud(event: KeyboardEvent): void;
  hideHud(): void;
}

// Arrow-key nudge tuning. A held key auto-repeats: every NUDGE_RAMP repeats the
// step grows by 1×, capped at NUDGE_MAX_MULT× (so it speeds up but tops out).
// The run commits NUDGE_COMMIT_MS after the last press; the HUD hides NUDGE_HUD_MS after.
const NUDGE_MAX_MULT = 8;
const NUDGE_RAMP = 3;
const NUDGE_COMMIT_MS = 220;
const NUDGE_HUD_MS = 1000;

/** Keyboard movement lifecycle: individual taps, accelerated holds, delayed commit,
 * and tool-switch cleanup. It intentionally does not generalize pointer gestures
 * or preview cancellation, which have different history and geometry contracts. */
export class NudgeSession {
  private readonly host: NudgeHost;

  constructor(host: NudgeHost) { this.host = host; }

  // --- Arrow-key nudge state ---
  private nudgeRepeat = 0;        // consecutive auto-repeats (drives acceleration)
  private nudgeRunOpen = false;   // an undo entry exists for the current run
  private nudgeHeld = false;      // the run included held repeats (needs amend on commit)
  private nudgeCommitTimer = 0;
  private nudgeHudTimer = 0;

  /**
   * Move the selection by a canvas-space delta (keyboard nudge, base dx/dy).
   * Uses the same rotation/nesting-aware translate as a drag, so it behaves like a
   * tiny drag. A discrete press is its own undo step; a HELD key auto-repeats,
   * accelerating (capped) and folding the whole hold into a SINGLE undo step.
   * Locked shapes are skipped. Shows the gesture-hint HUD.
   */
  nudge(dx: number, dy: number, e: KeyboardEvent): void {
    const shapes = this.host.movableSelection();
    if (shapes.length === 0) return;

    if (e.repeat) {
      // Held key: accelerate, and skip panel rebuilds until the run commits.
      this.nudgeRepeat++;
      this.nudgeHeld = true;
      this.host.setInteractive(true);
    } else {
      // Fresh press: close any previous run so each tap is its own undo step.
      this.commitNudgeRun();
      this.nudgeRepeat = 0;
    }

    const mult = Math.min(NUDGE_MAX_MULT, 1 + Math.floor(this.nudgeRepeat / NUDGE_RAMP));
    for (const s of shapes) this.host.translateElement(s.element, dx * mult, dy * mult);
    // A moved frame carries the derived artboards cache — resync it (as a drag does).
    if (shapes.some((s) => s.type === 'frame')) this.host.syncFrames();

    if (!this.nudgeRunOpen) {
      this.host.saveHistory(); // first move of this run → one undo entry
      this.nudgeRunOpen = true;
    }
    this.host.onChange();

    // Commit the run shortly after movement stops (ends the held-run undo step).
    clearTimeout(this.nudgeCommitTimer);
    this.nudgeCommitTimer = window.setTimeout(() => this.commitNudgeRun(), NUDGE_COMMIT_MS);

    // Teaching HUD — auto-hides a beat after nudging stops.
    this.host.showHud(e);
    clearTimeout(this.nudgeHudTimer);
    this.nudgeHudTimer = window.setTimeout(() => this.host.hideHud(), NUDGE_HUD_MS);
  }

  /** Finalize the current nudge run: a nudge is a move like any drag, so it
   *  commits through the move seam — amending, so the run's movement + any
   *  reparent stay one undo entry (#222). */
  private commitNudgeRun(): void {
    if (!this.nudgeRunOpen) return;
    this.nudgeRunOpen = false;
    clearTimeout(this.nudgeCommitTimer);
    this.host.commitMove();
    if (this.nudgeHeld) {
      this.host.setInteractive(false);
      this.nudgeHeld = false;
    }
    this.host.onChange(); // full render — side panels catch up
  }

  deactivate(): void {
    // Finalize any in-flight nudge run and clear its HUD so nothing lingers when
    // the user switches tools mid-nudge.
    this.commitNudgeRun();
    clearTimeout(this.nudgeHudTimer);
    this.host.hideHud();
  }
}
