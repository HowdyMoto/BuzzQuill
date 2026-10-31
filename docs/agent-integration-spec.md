# Agent integration design boundary

Status: proposed, not implemented.

BuzzQuill runs entirely in the browser. Documents live in local files,
local browser session storage, or the user's Google Drive. There is no application
account service, hosted document database, relay, or server-side model proxy.

Any future agent integration must start from this architecture:

- Model actions use the existing command registry and AppState APIs.
- An action identifies its document; asynchronous work retains that identity and
  content revision through completion.
- SVG, PDF, clipboard content and tool output remain untrusted. Apply the same
  import sanitization and CSP as manual imports.
- Google authorization is optional and uses drive.file. An agent must not receive
  the user's bearer token or broaden the requested scope.
- Authorization popups and external file selection remain user gestures.
- Remote models or relays need a separately reviewed design, clear data-sharing
  consent, and explicit credential custody; none is supplied by this repository.
- Never place private credentials in browser configuration or VITE_ variables.

No backend deployment or hosted credentials are required to develop the editor.
