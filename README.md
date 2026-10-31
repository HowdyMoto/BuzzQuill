# BuzzQuill

A browser-based SVG vector editor built with TypeScript and Vite. Draw, edit,
organize and export artwork locally, with optional saving to your own Google Drive.
No application account, database or backend server is required.

## Run locally

Use Node.js **22.13 or newer in the 22.x line**, or **24.x**, and npm.
The `.nvmrc` selects Node 22. The pinned PDF and build dependencies need these
versions; Node 18 is not supported.

```sh
npm ci
npm run dev
```

Open http://localhost:5180. Local editing works without an environment file.
For another port: `npm run dev -- --port 5276 --strictPort`.

## Optional Google Drive

Copy `.env.example` to `.env.local` and follow its Google Cloud setup instructions.
Provide your own public OAuth client ID and restricted Picker API key. Enable
Drive and Picker APIs, allow your exact JavaScript origins, and restrict the API
key to your host and the Picker API. Rebuild after changing these values.

The browser requests only `drive.file` and sends artwork directly to Google.
There is no private OAuth client secret or refresh token in this application.
Never put private credentials in a `VITE_` variable: those values ship to browsers.
New files are saved in a `BuzzQuill` folder in My Drive, created when needed.
Existing files keep their current location. With `drive.file`, only folders
already available to this app can be reused; an unrelated manually created
folder with the same name may not be visible to the app.
Drive saves are explicit, not background autosaves. Disconnect attempts to revoke
Google access and always clears the local credential; a failed revocation is
reported with instructions to remove access in Google Account settings. After
Disconnect, choose Connect Google Drive explicitly before saving there again.

Open documents, preferences and recent-file names remain on the device after
Disconnect. Use browser site-data controls to clear them on a shared computer.

## Features

- Paths, geometric shapes, text, images, layers, groups, symbols and frames.
- Gradients, patterns, strokes, shadows, clipping, masks and boolean operations.
- Multiple document tabs, split view, undo/redo, snapping and alignment.
- SVG and PDF import; vector and raster export; editable plain-SVG project files.
- Local session recovery and optional Google Drive open/save.

## Build and deploy

Production deploys automatically from `master` after GitHub checks pass. See
[deployment setup and release versioning](docs/deployment.md) for configuration
and manual redeploys.

```sh
npm run build
npm run preview
```

The static site is in `dist/`; preview uses port 5180. The build generates
`third-party-notices.txt` with license texts from the installed dependencies.
Cloudflare Pages can use `npm run build` and output directory `dist`, with a
supported Node version configured. Other static hosts must reproduce the response
headers in `public/_headers`, especially CSP and frame protection. The injected
meta CSP alone cannot supply `frame-ancestors`. Keep popup-compatible COOP for GIS.

For a fork, use your own Google project and review the production URLs in
`index.html`, `public/robots.txt`, `public/sitemap.xml`, `public/manifest.webmanifest`,
`src/ui/legal.ts` and `public/privacy.html`. Replace support/community links and
review branding and privacy copy for your deployment. Do not deploy using another
operator's credentials or imply that their support channels serve your fork.

## Tests

```sh
npm run test:unit
npm test -- test/drive.spec.ts test/save-ownership.spec.ts test/svg-security.spec.ts
npm run secrets:check
```

Browser tests use system Chrome locally and Playwright Chromium in CI. They start
their own server with dummy Google identifiers; Drive tests mock all Google calls.
Set `BQ_TEST_PORT` to use an isolated port. Do not point tests at production.

`npm test` includes the broader browser suite. Large SVG corpus and W3C smoke
files are optional downloads, not included in the repository:

```sh
npm run corpus:fetch
npm run smoke:fetch
npm test
```

Hand-made SVG fixtures live in `test/fixtures/`. The smoke operation matrix is
`npm run smoke -- <dev-server-port>`; visual walkthroughs use
`npm run walkthrough -- <dev-server-port> <output-directory> headless`.

## Source map

- `src/entry.ts`: boot and desktop gate; lazily loads `src/main.ts`.
- `src/core/`: SVG document state, geometry, history, document tabs and persistence.
- `src/tools/`: tools including `frame-tool.ts`, path editing, selection, and `direction.ts` for reversing path direction.
- `src/ui/`: panels, `frame-renderer.ts`, file import/export and Drive workflows.
- `src/lib/`: optional Google browser integration.
- `scripts/`: tests, notices, secret checks and clean release preparation.

The SVG DOM is the document's source of truth. See `CLAUDE.md` for implementation
invariants, `CONTRIBUTING.md` for contribution checks, and `SECURITY.md` for private
security reporting. Paper.js, opentype.js and PDF.js support geometry and imports;
fonts are bundled through Fontsource.

## Public release preparation

See [the release guide](docs/public-release.md). `npm run release:snapshot -- <new-directory>`
exports only a clean committed HEAD, without Git history or local environment files.
It does not publish, change repository visibility, or retire hosted resources.
Review the resulting manifest and run the independent Gitleaks scan before release.

## License

[MIT](LICENSE) — copyright 2026 WrightGeist LLC. The BuzzQuill name and logo are
not covered by the MIT license. Third-party code and fonts retain their own
licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
