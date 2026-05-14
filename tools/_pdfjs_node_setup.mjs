// Node-side replacement for src/parser/pdfjsSetup.js so the parser modules can
// be imported and run outside the browser without Vite's ?url import.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  '../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
  import.meta.url
).href;
export default pdfjsLib;
