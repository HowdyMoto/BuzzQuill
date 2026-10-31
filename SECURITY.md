# Security

Please do not open a public issue containing an exploit, credential, private
artwork or account data. Use the repository's **Security > Report a vulnerability**
(private vulnerability reporting) when enabled. If that option is unavailable,
contact the maintainer through a private contact channel listed on their GitHub
profile; do not send sensitive details to public issues or community chat.

Include the affected commit, minimal dummy-data reproduction, expected behavior
and observed impact. Do not test against other users, production accounts or
hosted services without the owner's permission.

The current default branch is the maintained version. Browser OAuth client IDs
and restricted Picker API keys are intentionally public; private client secrets,
service-role keys and bearer tokens must never be committed or placed in VITE_
variables. If a real secret is exposed, revoke or rotate it first, then arrange
history/artifact cleanup with the owner.

Run `npm run secrets:check` for the repository guard and Gitleaks for independent
history, directory and built-artifact scanning. CI uses redacted reports and no
production credentials. See docs/public-release.md for operator responsibilities.
