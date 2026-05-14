/**
 * Centralized pdf.js loader. We import the ESM build and explicitly point
 * the worker to the matching module file from pdfjs-dist (via Vite's ?url import).
 */
import * as pdfjsLib from 'pdfjs-dist';
// eslint-disable-next-line import/no-unresolved
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export default pdfjsLib;
