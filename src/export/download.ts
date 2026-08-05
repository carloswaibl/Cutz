/**
 * Saving generated files to disk, browser-side.
 *
 * There is no server to POST to and nothing to upload - the file is built in
 * memory and handed straight to the browser's download machinery. That is the
 * whole mechanism, and it is why exports work offline in a shop with no wifi.
 */

export interface ExportFile {
  filename: string;
  contents: string;
  mimeType: string;
}

export const SVG_MIME_TYPE = 'image/svg+xml';

/**
 * Gap between successive downloads, in ms.
 *
 * Chrome throttles rapid programmatic downloads and will silently drop the ones
 * that arrive too fast. It also asks the user's permission the first time a
 * page downloads more than one file, which is why the UI says so on the control.
 */
const MULTI_DOWNLOAD_GAP_MS = 300;

/** Trigger a download of one in-memory file. */
export function downloadFile(file: ExportFile): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('downloadFile requires a browser environment');
  }

  const blob = new Blob([file.contents], { type: file.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Revoking synchronously can cancel the download in Safari, which reads the
    // blob after the click handler returns.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Trigger several downloads in order, spaced out enough that none are dropped. */
export async function downloadFiles(files: ExportFile[]): Promise<void> {
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file) continue;
    downloadFile(file);
    if (i < files.length - 1) {
      await delay(MULTI_DOWNLOAD_GAP_MS);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
