// ---------------------------------------------------------------------------
// Google Picker — Google's own file chooser, in an iframe from docs.google.com.
//
// Under the `drive.file` scope the Picker is not just a UI nicety: picking a file
// in it is what GRANTS the app access to that file. That is why `setAppId` must
// carry this app's Cloud project number (lib/google-config.ts) — a mismatch means
// the grant lands on a different app and every download 404s.
// ---------------------------------------------------------------------------

import { GOOGLE_API_KEY, GOOGLE_APP_ID } from './google-config';
import { loadScript } from './google-drive';

const PICKER_SRC = 'https://apis.google.com/js/api.js';
/** What the editor can open: its own SVG files, and PDFs (imported as pages). */
const PICKABLE_MIME_TYPES = 'image/svg+xml,application/pdf';

export interface PickedFile { id: string; name: string; mimeType: string }

let pickerReady: Promise<void> | null = null;

function loadPicker(): Promise<void> {
  pickerReady ??= loadScript(PICKER_SRC).then(() => new Promise<void>((resolve) => gapi.load('picker', resolve)));
  return pickerReady;
}

/** Show the Picker over the editor; resolves the chosen file, or null on cancel. */
export async function pickDriveFile(token: string): Promise<PickedFile | null> {
  await loadPicker();
  return new Promise<PickedFile | null>((resolve) => {
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes(PICKABLE_MIME_TYPES)
      .setIncludeFolders(true);
    const picker = new google.picker.PickerBuilder()
      .setDeveloperKey(GOOGLE_API_KEY)
      .setAppId(GOOGLE_APP_ID)
      .setOAuthToken(token)
      .addView(view)
      .setTitle('Open from Google Drive')
      .setCallback((r) => {
        if (r.action === google.picker.Action.PICKED) {
          const d = r.docs?.[0];
          picker.dispose();
          resolve(d ? { id: d.id, name: d.name, mimeType: d.mimeType } : null);
        } else if (r.action === google.picker.Action.CANCEL) {
          picker.dispose();
          resolve(null);
        }
      })
      .build();
    picker.setVisible(true);
  });
}
