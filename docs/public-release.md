# Preparing a public release

## Repository and artifacts

1. Review and commit the intended release on the default branch. Run unit tests,
   the focused browser suites, production build and `npm run secrets:check`.
2. Run a maintained independent scanner against all intended Git refs and the
   actual build output. CI pins Gitleaks and its download checksum, redacts matches,
   and uses a read-only GitHub token with no production credentials.
3. For a new public history, run
   `npm run release:snapshot -- ../buzzquill-public-candidate` from a clean checkout.
   This exports only committed regular files, rejects symlinks/local configuration,
   and writes a SHA-256 manifest. It refuses to overwrite an existing directory.
4. Review and scan that directory, initialize a new repository there, and keep the
   existing private repository as the historical archive. Copying an entire working
   directory is unsafe: ignored environment files, caches and screenshots may be present.
5. Enable private vulnerability reporting and secret scanning/push protection where
   available. Review branch protection, workflow permissions, issues, attachments,
   releases, wiki, old deployments and any remote-only refs before changing visibility.
   Publishing a new snapshot avoids exposing the old repository's conversation/history.

If any actual secret is discovered, revoke/rotate it before history cleanup. A
deletion commit does not remove historical contents. Do not publish private audit
reports or operator inventories alongside source.

## Operator retirement checklist

Source cleanup does not stop hosted services. Keep the actual resource inventory
and any private exports outside this repository.

- Distinguish the new browser Drive OAuth client from former backend OAuth clients.
  Verify new origin restrictions, requested scope, Picker API/referrer restrictions,
  and exact production/preview domains. Disable unused clients and obsolete redirects.
- Inventory the retired backend's documents, users, sessions, storage, functions,
  database webhooks, scheduled jobs, secret vault and outbound webhooks. Decide data
  retention/export requirements before deleting anything. Removing the source does
  not prove these resources have stopped or their credentials have been revoked.
- Remove obsolete build variables and revoke unused provider/webhook credentials.
  Review historical deployments that may still serve the old application.
- Browser startup removes recognized retired auth-cache entries without touching
  artwork. That local cleanup does not revoke server sessions; handle that in the
  provider console. Keep document-format migration code for existing users.

These are operator actions, not commands a contributor should execute against the
original deployment. A fork needs its own Google project and hosting settings.

## Deployment and notices

Ship `dist/third-party-notices.txt` with the build. Reproduce `public/_headers` on
non-Cloudflare hosts and verify local-only and configured-Drive deployments. Use
mocked Google endpoints for tests; never use production accounts in CI.

Review canonical URLs, sitemap/robots, PWA identity, community/support links,
privacy text and brand assets for a fork. The project license does not grant the
BuzzQuill name/logo or override third-party code/font licenses.
