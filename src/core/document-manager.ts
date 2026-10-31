import type { AppState } from './state';
import { clearFocusedStyle } from '../ui/style-panel';
import type { CanvasController, ViewState } from './canvas';
import type { HistorySnapshot } from './history';
import { serializeDocumentSVG, loadDocumentSVG, setProjectName, getProjectName, hasDiskCopy, setDiskCopy, type PendingOpen } from '../ui/project-file';
import { getDocSource, setDocSource, type DocSource } from './doc-source';
import type { Session, SessionTab } from './session-store';
import { registerSaveOwner, type DocumentSaveTarget } from './document-save';

/**
 * Multiple open documents as tabs. There is one live {@link AppState}; the ACTIVE
 * tab's document lives in it. Inactive tabs are held as a serialized snapshot
 * (full SVG incl. defs/metadata) plus their cached undo stack, viewport, and
 * selection. Switching a tab serializes the current document into its tab and
 * loads the target — so each tab keeps its own shapes, defs, undo history, zoom,
 * and selection. (Instant DOM-swap could avoid the serialize round-trip, but this
 * approach reuses the proven serialize/load path with far less rewiring.)
 */
export interface DocTab {
  id: string;
  title: string;
  svg: string | null;          // serialized doc for an inactive tab (null = active or blank)
  history: HistorySnapshot | null;
  view: ViewState | null;
  selection: string[];
  dirty: boolean;
  /** True when this tab was restored from a session snapshot that held unsaved
   *  changes: the tab reads "clean" (no reload nag) but its saved copy is
   *  stale and the delta's only home is the session store — so the close guard
   *  must still prompt (issue #178). Cleared when a save lands (the dirty
   *  true→false transition) and re-derived through serializeSession. */
  restoredDirty?: boolean;
  /** Where this tab's document lives (core/doc-source.ts), per-tab so Save writes
   *  to THIS tab's file, not another tab's. The ACTIVE tab's live value is the
   *  doc-source singleton; this cache is refreshed only on switch-away. */
  source: DocSource;
  /** An unwritable copy of this tab's content exists on disk (see hasDiskCopy):
   *  opened without a handle, or saved by download. Travels with the tab like the
   *  source, and counts as a home in closeWouldLoseWork. */
  diskCopy: boolean;
  /** Editor group this tab belongs to: 0 = left pane, 1 = right pane. Only group 0
   *  exists until the workspace is split; then tabs can be dragged between the two.
   *  Not persisted — a restored session always starts unsplit (all tabs in group 0). */
  group: 0 | 1;
}

/** Title-bar display name for a tab title: the sentinel 'Untitled' collapses to
 *  null — the placeholder the label shows for an unnamed document. */
function displayName(title: string): string | null {
  return title === 'Untitled' ? null : title;
}

export class DocumentManager {
  tabs: DocTab[] = [];
  activeId: string;
  private counter = 0;
  private readonly state: AppState;
  private readonly canvas: CanvasController;
  private readonly onChange: () => void;

  constructor(state: AppState, canvas: CanvasController, onChange: () => void) {
    this.state = state;
    this.canvas = canvas;
    this.onChange = onChange;
    // Tab 0 adopts the document already loaded into AppState at boot.
    const id = this.nextId();
    this.tabs.push(this.blankTab(id, 'Untitled'));
    this.activeId = id;
    this.groupShown[0] = id;
    registerSaveOwner(state, (snapshot) => this.captureSave(snapshot));
  }

  private readonly saving = new Set<string>();

  /** Keep file identity and the saved baseline attached to the initiating tab,
   * including when that tab is inactive or closed by the time a write finishes. */
  private captureSave(snapshot: string): DocumentSaveTarget | null {
    const tab = this.active;
    if (this.saving.has(tab.id)) return null;
    this.saving.add(tab.id);
    const history = this.state.exportHistory();
    const savedEntry = history.entries[history.index];
    return {
      source: getDocSource(),
      name: getProjectName(),
      isOpen: () => this.tabs.includes(tab),
      release: () => { this.saving.delete(tab.id); },
      complete: (source, name, diskCopy = false) => {
        if (!this.tabs.includes(tab)) return;
        const active = this.activeId === tab.id;
        const unchanged = (active ? serializeDocumentSVG(this.state) : tab.svg) === snapshot;
        const currentHistory = active ? this.state.exportHistory() : tab.history;
        if (currentHistory) {
          const savedIndex = savedEntry ? currentHistory.entries.indexOf(savedEntry) : -1;
          currentHistory.savedIndex = unchanged ? currentHistory.index
            : savedIndex === currentHistory.index ? -1 : savedIndex;
          if (active) this.state.importHistory(currentHistory);
        }
        tab.source = source;
        tab.title = name;
        tab.diskCopy = diskCopy;
        tab.dirty = !unchanged;
        if (unchanged) tab.restoredDirty = false;
        if (active) {
          setDocSource(source);
          setProjectName(displayName(name));
          setDiskCopy(diskCopy);
          this.state.onChange_public();
        }
        this.onChange();
      },
    };
  }

  get active(): DocTab { return this.tabs.find(t => t.id === this.activeId)!; }

  // -------------------------------------------------------------------------
  // Editor groups (split view). Group 0 = left pane, 1 = right. The FOCUSED group
  // (the one holding the active tab) is the live editor; the other pane shows a
  // snapshot of its shown tab and becomes live the moment you click into it.
  // -------------------------------------------------------------------------

  private tabById(id: string): DocTab | undefined { return this.tabs.find(t => t.id === id); }

  /** True once any tab lives in group 1 — i.e. the workspace is split in two. */
  get splitOn(): boolean { return this.tabs.some(t => t.group === 1); }

  /** The group holding the live/active tab (0 when unsplit). */
  get focusedGroup(): 0 | 1 { return this.tabById(this.activeId)?.group ?? 0; }

  /** Tabs belonging to a group, in tab-bar order. */
  tabsInGroup(g: 0 | 1): DocTab[] { return this.tabs.filter(t => t.group === g); }

  /** Which tab a group is currently showing: the live tab for the focused group,
   *  otherwise its remembered tab (falling back to the group's first tab if that
   *  was closed/moved away). null = the group has no tabs. */
  shownInGroup(g: 0 | 1): string | null {
    if (g === this.focusedGroup) return this.activeId;
    const remembered = this.groupShown[g];
    if (remembered && this.tabById(remembered)?.group === g) return remembered;
    return this.tabsInGroup(g)[0]?.id ?? null;
  }

  /** Make tab `id` the live/focused document (clicking a tab or its pane). Records
   *  it as its group's shown tab, then swaps it live if it isn't already. */
  focusTab(id: string): void {
    const t = this.tabById(id);
    if (!t) return;
    this.groupShown[t.group] = id;
    if (id === this.activeId) { this.onChange(); return; } // already live — just re-render chrome
    this.switchTo(id); // serializes the outgoing tab (updating its snapshot) and loads this one
  }

  /** Give focus to a whole pane (clicking its canvas): make that group's shown tab live. */
  focusGroup(g: 0 | 1): void {
    if (g === this.focusedGroup) return;
    const id = this.shownInGroup(g);
    if (id) this.focusTab(id);
  }

  /** Enter split: give the right pane a document — the rightmost other tab if there
   *  is one, else a fresh blank — without disturbing what's live on the left. */
  enterSplit(): void {
    if (this.splitOn) return;
    const others = this.tabsInGroup(0).filter(t => t.id !== this.activeId);
    if (others.length) {
      others[others.length - 1].group = 1;
      this.groupShown[1] = others[others.length - 1].id;
    } else {
      const id = this.nextId();
      this.tabs.push(this.blankTab(id, `Untitled ${this.tabs.length + 1}`, 1));
      this.groupShown[1] = id;
    }
    this.onChange();
  }

  /** Leave split: pull every tab back into group 0 (the live tab stays live). */
  exitSplit(): void {
    if (!this.splitOn) return;
    for (const t of this.tabs) t.group = 0;
    this.groupShown[1] = null;
    this.onChange();
  }

  toggleSplit(): void { if (this.splitOn) this.exitSplit(); else this.enterSplit(); }

  /** Move a tab into a group (dragging a tab across the divider), positioned before/
   *  after `beforeId` when dropped onto another tab, or appended when dropped on empty
   *  pane space. Focuses the moved tab so it lands live where you dropped it. If the
   *  move empties a group, the split collapses back to a single pane. */
  moveTabToGroup(draggedId: string, group: 0 | 1, beforeId: string | null, after: boolean): void {
    const t = this.tabById(draggedId);
    if (!t) return;
    this.tabs.splice(this.tabs.indexOf(t), 1);
    t.group = group;
    if (beforeId) {
      const ti = this.tabs.findIndex(x => x.id === beforeId);
      if (ti < 0) this.tabs.push(t); else this.tabs.splice(after ? ti + 1 : ti, 0, t);
    } else {
      this.tabs.push(t);
    }
    this.groupShown[group] = draggedId;
    // Dragging a group's last tab away collapses the split (never leave an empty pane).
    if (this.tabsInGroup(0).length === 0 || this.tabsInGroup(1).length === 0) {
      for (const x of this.tabs) x.group = 0;
      this.groupShown[1] = null;
    }
    this.focusTab(draggedId);
  }

  private nextId(): string { return `doc-${++this.counter}`; }

  /** Per-editor-group memory of which tab that group is *showing*. The focused
   *  group always shows the live tab (activeId); this only needs to remember the
   *  OTHER group's tab across focus changes. Self-heals via shownInGroup() if a
   *  remembered tab is closed or moved out of the group. */
  private groupShown: (string | null)[] = [null, null];

  private blankTab(id: string, title: string, group: 0 | 1 = 0): DocTab {
    return { id, title, svg: null, history: null, view: null, selection: [], dirty: false, source: null, diskCopy: false, group };
  }

  /** Serialize the live document into its tab — every swap that keeps the outgoing
   *  document (switch, new tab, open) goes through here, so a live tool session is
   *  ended FIRST and its result is what gets saved. */
  private saveActiveIntoTab(): void {
    this.endToolSession();
    const t = this.active;
    t.svg = serializeDocumentSVG(this.state);
    t.history = this.state.exportHistory();
    t.view = this.canvas.getViewState();
    t.selection = [...this.state.selectedShapeIds];
    t.dirty = this.state.dirty;
    t.title = this.currentTitle();
    // Capture where this document lives, so it travels with the tab and Save
    // targets the correct file after a switch.
    t.source = getDocSource();
    t.diskCopy = hasDiskCopy();
  }

  /** Make the live AppState fully reflect tab `t`: content, history, view, selection,
   *  source, and display name. Runs as ONE atomic change — observers
   *  only ever see the finished tab, never a half-loaded intermediate. That atomicity
   *  is load-bearing: the content load fires change notifications that render the tab
   *  bar, and a render mid-load would read the OUTGOING tab's title/identity back into
   *  the incoming tab. runBatched coalesces those into a single notify emitted after
   *  everything below is in place. */
  private loadTabIntoState(t: DocTab): void {
    this.state.runBatched(() => {
      if (t.svg == null) {
        this.state.clearAll(); // fresh blank document (default frame)
      } else {
        loadDocumentSVG(this.state, t.svg); // rebuilds content + defs, resets history
        if (t.history) this.state.importHistory(t.history);
        if (t.view) this.canvas.setViewState(t.view);
        const sel = t.selection.filter(id => this.state.findShapeById(id));
        if (sel.length) this.state.selectMultiple(sel);
      }
      // Re-tether THIS tab's source (the load above may have changed it). Without
      // this, Save would write here to the previous tab's file — silent
      // cross-document data loss. The one writer besides project-file's adoptSource.
      setDocSource(t.source);
      setDiskCopy(t.diskCopy);
      // The tab's name is part of its identity — set it inside the batch too, so the
      // single post-load render shows the right title.
      setProjectName(displayName(t.title));
    });
  }

  private currentTitle(): string {
    return getProjectName();
  }

  /** Where the ACTIVE document lives, live. (`active.source` is the per-tab cache,
   *  refreshed only on switch-away — see refreshActive.) */
  get activeSource(): DocSource {
    return getDocSource();
  }

  /** New blank document. Joins `group` (defaults to the focused group, so the pane's
   *  own + button adds to that pane) and becomes the live tab. */
  newTab(group: 0 | 1 = this.focusedGroup): void {
    this.saveActiveIntoTab();
    const id = this.nextId();
    this.tabs.push(this.blankTab(id, `Untitled ${this.tabs.length + 1}`, group));
    this.groupShown[group] = id;
    this.activeId = id;
    this.loadTabIntoState(this.active); // clearAll → blank doc, sets the display name
    this.state.markClean(); // a fresh empty tab has nothing to save (matches File ▸ New)
    this.centerOnArtboards(); // a new blank doc has no saved view — centre its frame
    this.onChange();
  }

  /** Fit + centre the view on the document's frame(s). Used when a brand-new blank
   *  document is created (it has no saved viewport of its own to restore). */
  private centerOnArtboards(): void {
    const abs = this.state.artboards;
    if (!abs.length) { this.canvas.fitToWindow(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ab of abs) {
      minX = Math.min(minX, ab.x); minY = Math.min(minY, ab.y);
      maxX = Math.max(maxX, ab.x + ab.width); maxY = Math.max(maxY, ab.y + ab.height);
    }
    this.canvas.fitToWindow({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
  }

  /**
   * Open a picked document (File ▸ Open, Recent Files). Loads into a NEW tab so
   * the current tab — and any unsaved work in it — is left untouched; the only
   * exception is a pristine-blank current tab (nothing to lose), which is reused
   * so Open on a fresh app doesn't leave an empty tab behind. Because nothing is
   * replaced, there's no discard prompt (the source of the "warning about the
   * file I'm editing" this fixes).
   */
  async openDocument(pending: PendingOpen): Promise<void> {
    if (!this.activeTabIsBlank()) {
      this.saveActiveIntoTab();
      const id = this.nextId();
      this.tabs.push(this.blankTab(id, pending.name));
      this.activeId = id;
      this.loadTabIntoState(this.active); // blank the live state for the new tab
    }
    await pending.load(this.state);       // loads content; sets project name + file handle
    this.active.title = this.currentTitle();
    this.active.dirty = this.state.dirty; // a freshly-loaded document is clean
    this.syncProjectName();
    this.onChange();
  }

  /** True when the live document is a pristine blank — no unsaved edits, no source,
   *  and no content beyond empty frames — so Open may load over it instead of
   *  spawning a new tab. */
  private activeTabIsBlank(): boolean {
    if (this.state.dirty || getDocSource()) return false;
    return this.state.shapes.every((s) => s.type === 'frame' && (s.children?.length ?? 0) === 0);
  }

  /** Would closing this tab throw away the only copy of real work? A dirty tab
   *  always would. So would a RESTORED tab that holds content but has no durable
   *  home (no source): restoreSession marks such tabs clean, yet
   *  their only copy is the session snapshot — and closing a tab drops it from the
   *  next snapshot (serializeSession rebuilds from the still-open tabs). Pristine
   *  tabs, and tabs backed by a file, are safe to close silently.
   *  Gates the close confirmation so an hour of unsaved-untitled work can't vanish
   *  with no prompt (issue #178). */
  closeWouldLoseWork(id: string): boolean {
    const t = this.tabs.find(x => x.id === id);
    if (!t) return false;
    if (t.dirty) return true;
    // A restored tab whose snapshot held unsaved changes: it reads clean and may
    // even have a home, but that copy is STALE — the delta's only
    // home is the session snapshot this close would drop (#178).
    if (t.restoredDirty) return true;
    const active = id === this.activeId;
    // A file the editor can't write to still counts: a clean tab opened from one (no
    // File System Access, a dropped file) or saved as a download IS that file.
    const hasHome = active
      ? (!!getDocSource() || hasDiskCopy())
      : (!!t.source || t.diskCopy);
    if (hasHome) return false;
    return this.tabHasContent(id);
  }

  /** Real content = any modeled shape beyond empty frames (mirrors the
   *  activeTabIsBlank definition). The active tab reads the live model; a cached
   *  tab is checked against its stored snapshot — a non-frame `shape-N` element
   *  means real work. */
  private tabHasContent(id: string): boolean {
    if (id === this.activeId) {
      return this.state.shapes.some(s => s.type !== 'frame' || (s.children?.length ?? 0) > 0);
    }
    const svg = this.tabs.find(t => t.id === id)?.svg;
    if (!svg) return false;
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    for (const el of Array.from(doc.querySelectorAll('[id^="shape-"]'))) {
      const isFrame = el.tagName.toLowerCase() === 'g' && el.hasAttribute('data-frame');
      if (!isFrame) return true;
    }
    return false;
  }

  /** A crop session edits one document's element through an overlay. Swapping the
   *  document out from under it left the overlay drawn over the next tab, where
   *  Enter committed into the wrong document. End it first — a tool switch keeps
   *  the crop, as it always does — so the outgoing tab saves the finished result. */
  private endToolSession(): void {
    if (this.state.currentTool === 'crop') this.state.requestTool?.('select');
  }

  switchTo(id: string): void {
    if (id === this.activeId) return;
    const target = this.tabs.find(t => t.id === id);
    if (!target) return;
    this.saveActiveIntoTab();
    this.activeId = id;
    this.loadTabIntoState(target); // atomically loads content + identity + display name
    // Asset ids are document-scoped, so a style focused in the outgoing document
    // must not stay open — it would edit whatever asset shares that id here.
    clearFocusedStyle();
    this.onChange();
  }

  /** SVG to render for a tab in the split-view preview: the LIVE document when it's
   *  the active tab, otherwise the tab's stored snapshot (null = a never-used blank). */
  tabSvgSnapshot(id: string): string | null {
    if (id === this.activeId) return serializeDocumentSVG(this.state);
    return this.tabs.find(t => t.id === id)?.svg ?? null;
  }

  /** Close a tab. Closing the LAST tab doesn't leave the editor tab-less: it swaps
   *  in a fresh blank document under a brand-new tab id (so the tab bar animates it
   *  in), which is exactly closing the file and doing File ▸ New. Returns false only
   *  when the id doesn't exist. */
  closeTab(id: string): boolean {
    const idx = this.tabs.findIndex(t => t.id === id);
    if (idx < 0) return false;
    if (id === this.activeId) this.endToolSession();

    if (this.tabs.length === 1) {
      const blank = this.blankTab(this.nextId(), 'Untitled');
      this.tabs[idx] = blank;
      this.activeId = blank.id;
      this.loadTabIntoState(blank); // clearAll → blank doc, resets identity + display name
      this.state.markClean();       // a fresh empty tab has nothing to save
      this.centerOnArtboards();     // fresh blank doc — centre its frame
      this.onChange();
      return true;
    }

    const wasActive = id === this.activeId;
    const closingGroup = this.tabs[idx].group;
    this.tabs.splice(idx, 1);
    // A group that just lost its last tab can't stay a pane — collapse the split so
    // no empty canvas is left behind (all tabs fall back into group 0).
    if (this.splitOn && this.tabsInGroup(closingGroup).length === 0) {
      for (const t of this.tabs) t.group = 0;
      this.groupShown[1] = null;
    }
    if (wasActive) {
      // Prefer a neighbour in the SAME pane so focus doesn't hop across the divider;
      // fall back to any tab if that pane emptied (and thus collapsed above).
      const sameGroup = this.tabsInGroup(closingGroup);
      const next = sameGroup[Math.min(idx, sameGroup.length - 1)] ?? this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.activeId = next.id;
      this.loadTabIntoState(next); // loads content + identity + display name for the new active tab
    }
    this.onChange();
    return true;
  }

  /** Keep the active tab's title/dirty current (called from the render loop). */
  refreshActive(): void {
    this.active.title = this.currentTitle();
    // A dirty true→false transition is a completed save (or undo back to the
    // save point) — the durable copy now includes any restored session delta,
    // so the close guard can relax (#178).
    if (this.active.dirty && !this.state.dirty) this.active.restoredDirty = false;
    this.active.dirty = this.state.dirty;
    // NB: the active tab's source is deliberately NOT re-synced here. The live value
    // is the doc-source singleton, and the tab bar reads THAT for the active tab.
    // Writing it onto the DocTab here would run re-entrantly during loadTabIntoState
    // (loadDocumentSVG → onChange → renderTabBar → refreshActive) and clobber the
    // tab's source before the load finishes re-tethering it — silently dropping a
    // document's file.
  }

  /** Rename a tab (double-click on the tab). For the active tab this is also the
   *  document/project name — kept in sync so refreshActive() doesn't revert it. */
  renameTab(id: string, title: string): void {
    const t = this.tabs.find(x => x.id === id);
    if (!t) return;
    const clean = title.trim() || 'Untitled';
    if (t.title === clean) return;
    t.title = clean;
    if (id === this.activeId) setProjectName(clean === 'Untitled' ? null : clean);
    this.onChange();
  }

  /** Reorder tabs: move `draggedId` to just before/after `targetId` (drag-to-
   *  reorder). Content and the active tab are unchanged — only the order. */
  reorderTab(draggedId: string, targetId: string, after: boolean): void {
    if (draggedId === targetId) return;
    const from = this.tabs.findIndex(t => t.id === draggedId);
    if (from < 0) return;
    const [tab] = this.tabs.splice(from, 1);
    let ti = this.tabs.findIndex(t => t.id === targetId);
    if (ti < 0) { this.tabs.splice(from, 0, tab); return; } // target vanished — put it back
    this.tabs.splice(after ? ti + 1 : ti, 0, tab);
    this.onChange();
  }

  private syncProjectName(): void {
    setProjectName(displayName(this.active.title));
  }

  /** Any tab (active or cached) with unsaved edits — for beforeunload. */
  anyDirty(): boolean {
    return this.state.dirty || this.tabs.some(t => t.id !== this.activeId && t.dirty);
  }

  // -------------------------------------------------------------------------
  // Session persistence (restore-my-work-on-load). See core/session-store.ts.
  // -------------------------------------------------------------------------

  /** Snapshot every open tab as serializable content for the session store. The
   *  active tab is serialized live from AppState; inactive tabs use their cached
   *  SVG. The source travels with the tab so a file stays tethered across a reload.
   *  Undo history is dropped (store). */
  serializeSession(): Session {
    const tabs: SessionTab[] = this.tabs.map(t => {
      const active = t.id === this.activeId;
      return {
        title: active ? this.currentTitle() : t.title,
        svg: active ? serializeDocumentSVG(this.state) : t.svg,
        view: active ? this.canvas.getViewState() : t.view,
        selection: active ? [...this.state.selectedShapeIds] : [...t.selection],
        source: active ? getDocSource() : t.source,
        diskCopy: active ? hasDiskCopy() : t.diskCopy,
        // "Holds edits its saved copy doesn't": live dirt, or a delta carried
        // forward from an earlier restore that still hasn't been saved (#178).
        unsavedDelta: active
          ? (this.state.dirty || !!this.active.restoredDirty)
          : (t.dirty || !!t.restoredDirty),
      };
    });
    const activeIndex = Math.max(0, this.tabs.findIndex(t => t.id === this.activeId));
    return { tabs, activeIndex };
  }

  /** Rebuild all tabs from a persisted session and load the active one into the
   *  live AppState. Returns false (leaving the boot document untouched) if the
   *  session is empty. Restored documents come back clean — the session store IS
   *  the durable copy of the work. */
  restoreSession(session: Session): boolean {
    if (!session.tabs.length) return false;
    const activeIndex = Math.max(0, Math.min(session.activeIndex, session.tabs.length - 1));

    this.tabs = session.tabs.map(st => ({
      id: this.nextId(),
      title: st.title || 'Untitled',
      svg: st.svg,
      history: null,
      view: st.view,
      selection: st.selection ?? [],
      dirty: false,
      // Restored tabs read clean (the session store is the durable copy while the
      // tab stays open — no reload nag), but remember which ones hold a delta
      // their saved copy doesn't, so closing still prompts (#178).
      restoredDirty: st.unsavedDelta ?? false,
      source: st.source ?? null, // legacy records are normalized by session-store's migrateTab
      diskCopy: st.diskCopy ?? false,
      group: 0, // split state isn't persisted — a restored session starts unsplit
    }));

    const activeTab = this.tabs[activeIndex];
    this.activeId = activeTab.id;
    this.groupShown = [activeTab.id, null];
    // Load the active tab's stored SVG into AppState (or a blank doc if null) —
    // atomically, including its display name — then blank its cache to mark it live
    // per the active-tab convention.
    this.loadTabIntoState(activeTab);
    activeTab.svg = null;

    this.onChange();
    return true;
  }
}
