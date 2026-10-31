/**
 * Minimal ambient declarations for the File System Access API picker methods,
 * which TypeScript's DOM lib (5.9) does not yet include on Window.
 * FileSystemFileHandle / FileSystemWritableFileStream themselves come from lib.dom.
 */
interface OpenFilePickerOptions {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  excludeAcceptAllOption?: boolean;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}

interface Window {
  showOpenFilePicker(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
}
