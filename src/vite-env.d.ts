/// <reference types="vite/client" />

/** Package version, injected at build time via Vite `define` (see vite.config.ts). */
declare const __APP_VERSION__: string;

/** Build identity (short commit SHA + ISO date), injected by vite.config.ts. */
declare const __BUILD_SHA__: string;
declare const __BUILD_DATE__: string;

/** Build-time env vars (see .env.example). None are required; every optional
 *  integration must degrade to the plain editor when its vars are absent. */
interface ImportMetaEnv {
  /** Google Drive (lib/google-config.ts): a PUBLIC OAuth Web Client ID… */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  /** …and a PUBLIC, referrer-restricted API key for the Picker. Both or neither. */
  readonly VITE_GOOGLE_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** A WOFF2 font decoded to TTF at build time; the import is the TTF's URL (see the
 *  woff2-to-ttf plugin in vite.config.ts). */
declare module '*.woff2?ttf' {
  const url: string;
  export default url;
}
