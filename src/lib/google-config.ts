// ---------------------------------------------------------------------------
// Google Drive configuration — two PUBLIC identifiers, supplied at build time via
// Vite env vars (see .env.example). Neither is a secret: the OAuth Client ID is
// locked to the site's authorized JavaScript origins and the API key to its HTTP
// referrers, both in Google Cloud Console. Security comes from the `drive.file`
// scope (the app sees only files it created or the user picked), not from hiding
// these values.
//
// Leave them unset and every Drive feature is hidden: no script is loaded, no
// command is registered, the CSP stays 'self'-only (vite.config.ts gates the
// Google hosts on the same vars).
// ---------------------------------------------------------------------------

export const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';
export const GOOGLE_API_KEY: string = import.meta.env.VITE_GOOGLE_API_KEY ?? '';

/** True only when both values are present, i.e. Drive open/save is usable. */
export const isDriveConfigured: boolean = Boolean(GOOGLE_CLIENT_ID && GOOGLE_API_KEY);

/** The Cloud project NUMBER, which is the Client ID's prefix. The Picker needs it
 *  (`setAppId`) so that a file picked under `drive.file` is granted to THIS app. */
export const GOOGLE_APP_ID: string = GOOGLE_CLIENT_ID.split('-')[0] ?? '';

/** Per-file access only: files the user opens with the app or that it created. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

if (import.meta.env.DEV && !isDriveConfigured) {
  console.info('[drive] not configured — Google Drive features hidden. Set VITE_GOOGLE_CLIENT_ID / VITE_GOOGLE_API_KEY in .env.local to enable.');
}
