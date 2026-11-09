// Compatibility surface for readers of the active document source.
// Identity changes use adoptSource in document-identity, updating name/source/
// disk-copy together. DocumentManager retains inactive tab snapshots.
export { getDocSource } from './document-identity';
export type { DocSource, LocalSource, DriveSource } from './document-identity';
