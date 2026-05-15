import pdfjsLib from './pdfjsSetup.js';

/**
 * Open a PDF from a File/Blob/ArrayBuffer/URL and return a pdf.js document.
 * Kept separate from pageReader so headless tests can import the parser
 * modules without dragging in the Vite-specific worker URL.
 */
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
