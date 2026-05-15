// pdf.js bootstrap for the browser.
//
// Vite's `?url` import gives us a URL to the worker script that the worker
// loader can fetch. The legacy build is used for broader compatibility; the
// modern build assumes an ES-module worker which not every browser exposes.

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// eslint-disable-next-line import/no-unresolved
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export default pdfjsLib;

/** Open a PDF from a File / Blob / ArrayBuffer / URL. */
export async function openPdf(source) {
  let data;
  if (source instanceof ArrayBuffer) data = source;
  else if (source instanceof Uint8Array) data = source;
  else if (source instanceof Blob) data = new Uint8Array(await source.arrayBuffer());
  else if (typeof source === 'string') data = source;
  else throw new Error('Unsupported PDF source');

  return pdfjsLib.getDocument({
    data,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;
}
