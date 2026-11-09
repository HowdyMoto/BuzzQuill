import type { AppState } from './state';

/**
 * A picked document ready to load, with any load-time prompts (the PDF import
 * dialog) already resolved — so a caller can create a fresh tab and populate it
 * via {@link PendingOpen.load} with no risk of a late cancel leaving an empty tab.
 */
export interface PendingOpen {
  /** File name, used to title a freshly-created tab before content loads. */
  name: string;
  /** Load the picked document into `state` (no further prompts). */
  load: (state: AppState) => Promise<void>;
}

