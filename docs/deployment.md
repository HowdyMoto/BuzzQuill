# Production deployment

The public source is `HowdyMoto/BuzzQuill`, branch `master`. The former repository
is `HowdyMoto/BuzzQuill-private` and retains private history. Cloudflare's existing
`buzzquill` Pages project was originally attached to that former repository;
renaming a repository does not attach a newly created repository to Pages.

The `Checks` GitHub Actions workflow now deploys the public repository to the
existing Pages project after `verify` passes on a push to `master`. Pull requests
and forks cannot run the production job. Production uploads are serialized.
The custom domains stay on the existing project. Disable its old automatic Git
builds when enabling this workflow so two repositories cannot publish production.

Configure these in the public repository's **Settings → Secrets and variables →
Actions**:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | Account-scoped token with Cloudflare Pages Edit |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Hosting account ID |
| Variable | `CF_PAGES_PROJECT` | `buzzquill` |
| Variable | `VITE_GOOGLE_CLIENT_ID` | Current public Google OAuth client ID |
| Variable | `VITE_GOOGLE_API_KEY` | Current public, restricted Google Picker key |

The token stays in Actions secrets. Google identifiers are browser-public build
inputs and must have appropriate Google origin/API restrictions. They are not
copied into source files. Missing configuration fails deployment explicitly.

To redeploy, open **Actions → Checks → Run workflow**, select `master`, and run.
Checks run first. No manual package-version bump is needed.

## Release version

Each build gets a calendar version `YYYY.MM.DD.HHmmssSSS` using UTC, for example
`2026.10.31.071402123`. This increases with build time even when rebuilding the
same commit. It is a build identifier, not a count of successful deployments.
Failed builds never replace the live version; a deliberate rollback restores the
old artifact and its old version.

The About dialog shows this version and the commit. `/version.json` exposes the
same version, full commit SHA, and UTC build time for deployment verification.
The PWA cache and icon URLs use that same version, including same-commit rebuilds.
Local development versions end in `-dev`; `package.json` is not the deployed app's
release counter.

Fork owners should adapt the workflow's repository guard and configure their own
Pages project, domain, and Google identifiers.
