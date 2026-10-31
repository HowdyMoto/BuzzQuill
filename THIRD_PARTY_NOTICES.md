# Third-party notices

The MIT license covers this repository's original code, subject to the name/logo
exclusion described in README.md. Dependencies and bundled fonts retain their
original licenses and attribution requirements.

`npm run notices:generate` collects the license declarations and license/notice
texts of production JavaScript/font packages in package-lock.json from the installed node_modules. Native optional dependencies and development tools
are not browser assets and are excluded. The build
includes the resulting `third-party-notices.txt` in dist. Keep that file with
redistributed builds. The generator fails if a package has no license declaration
or no available license/notice text; resolve that before distributing.

Fontsource fonts are generally SIL Open Font License 1.1; their individual
license texts, copyright notices and reserved font names remain authoritative.
Do not treat all third-party material as MIT. Downloaded test corpora retain the
licenses recorded in their manifests and are not bundled in the application.
