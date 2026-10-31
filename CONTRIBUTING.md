# Contributing

Use the Node version and local setup in README.md. Start from the current default
branch and keep changes focused. Reproduce bugs with a minimal SVG or mocked
fixture; never attach private artwork, access tokens or account data.

Before a pull request, run `npm run test:unit`, `npm run build`,
`npm run secrets:check`, and browser tests covering the changed behavior.
For geometry/shared-shape changes also run the smoke operation matrix. Document
any intentionally skipped corpus downloads. Use dummy Google credentials and
mocked endpoints in tests; no external account is needed.

All asynchronous saves must retain the initiating document and saved content.
All imported markup must be sanitized before each live DOM insertion. Preserve
CSP, local-only startup, and backward compatibility with saved documents.

Do not commit environment files, local screenshots, generated build output,
credentials, or downloaded corpora. Report vulnerabilities privately as described
in SECURITY.md. Contributions are provided under the repository's MIT license.
