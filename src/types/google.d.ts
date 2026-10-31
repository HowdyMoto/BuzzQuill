// Ambient types for the two Google browser scripts the Drive integration loads at
// runtime (lib/google-drive.ts, lib/google-picker.ts): Google Identity Services
// (`google.accounts.oauth2`) and the Picker (`gapi` + `google.picker`). Hand-
// written and deliberately minimal — only the members the app calls — so the
// integration needs no `@types/*` dependency. Neither global exists until its
// script has loaded; the loaders await that before touching them.

declare namespace google.accounts.oauth2 {
  interface TokenResponse {
    access_token?: string;
    /** Seconds until expiry (a number, though some builds have sent a string). */
    expires_in?: number | string;
    scope?: string;
    error?: string;
    error_description?: string;
  }
  interface ClientConfigError {
    /** e.g. 'popup_closed', 'popup_failed_to_open', 'unknown' */
    type: string;
    message?: string;
  }
  interface TokenClientConfig {
    client_id: string;
    scope: string;
    include_granted_scopes?: boolean;
    callback: (response: TokenResponse) => void;
    error_callback?: (error: ClientConfigError) => void;
  }
  interface OverridableTokenClientConfig {
    prompt?: '' | 'none' | 'consent' | 'select_account';
  }
  interface TokenClient {
    requestAccessToken(override?: OverridableTokenClientConfig): void;
  }
  function initTokenClient(config: TokenClientConfig): TokenClient;
  interface RevocationResponse { successful: boolean; error?: string }
  function revoke(accessToken: string, done?: (response: RevocationResponse) => void): void;
}

declare namespace google.picker {
  interface DocumentObject { id: string; name: string; mimeType: string }
  interface ResponseObject { action: string; docs?: DocumentObject[] }
  class DocsView {
    constructor(viewId?: string);
    setMimeTypes(mimeTypes: string): DocsView;
    setIncludeFolders(include: boolean): DocsView;
  }
  interface Picker {
    setVisible(visible: boolean): void;
    dispose(): void;
  }
  class PickerBuilder {
    setDeveloperKey(key: string): PickerBuilder;
    setAppId(appId: string): PickerBuilder;
    setOAuthToken(token: string): PickerBuilder;
    addView(view: DocsView): PickerBuilder;
    setTitle(title: string): PickerBuilder;
    setCallback(cb: (response: ResponseObject) => void): PickerBuilder;
    build(): Picker;
  }
  const Action: { PICKED: string; CANCEL: string; LOADED: string };
  const ViewId: { DOCS: string };
}

declare namespace gapi {
  function load(library: string, callback: () => void): void;
}
