/**
 * Voice-note recorder — records straight to Ogg/Opus on EVERY browser via the
 * opus-recorder WASM encoder. We can't use the native MediaRecorder for this:
 * Chrome only records `audio/webm` and Safari/iOS only *fragmented* `audio/mp4`
 * (moof/mdat fragments). Both play locally but Meta's media pipeline can't
 * validate either as a voice note — it sniffs the bytes as
 * `application/octet-stream` and rejects the upload ("Please choose a different
 * file"). Ogg/Opus is WhatsApp's native voice-note format, accepted as a
 * push-to-talk bubble.
 *
 * The ~385 KB encoder worker is code-split: it loads on demand (and warms on
 * thread mount via preloadVoiceRecorder) so it stays out of the main bundle and
 * a mic tap can still start within the user-gesture window iOS needs to resume
 * the AudioContext. Goes through safeDynamicImport so a stale deploy recovers
 * instead of stranding the user (see lib/dynamicImport.js).
 */
import { safeDynamicImport } from './dynamicImport.js';

let modPromise = null;

/**
 * Warm the encoder chunk (worker JS + inlined wasm) ahead of the mic tap.
 * Idempotent — the first call kicks the dynamic import, the rest reuse it.
 */
export function preloadVoiceRecorder() {
  if (!modPromise) {
    modPromise = Promise.all([
      safeDynamicImport(() => import('opus-recorder')),
      import('opus-recorder/dist/encoderWorker.min.js?url'),
    ]).then(([rec, worker]) => ({
      Recorder: rec.default || rec,
      encoderPath: worker.default,
    }));
  }
  return modPromise;
}

/**
 * Whether this browser can capture a voice note at all (getUserMedia + Web
 * Audio + WebAssembly). Gates the mic button — false hides it entirely.
 */
export function canRecordVoice() {
  return typeof window !== 'undefined'
    && typeof WebAssembly !== 'undefined'
    && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    && !!(window.AudioContext || window.webkitAudioContext);
}

/**
 * Start recording. MUST be called from a user gesture (the mic tap) so iOS lets
 * the AudioContext resume. Returns a controller:
 *   - `stop()`   → resolves to an `audio/ogg` (Opus) Blob (or null if empty),
 *   - `cancel()` → tears the recorder down and discards the audio.
 * Rejects if mic permission is denied.
 */
export async function startVoiceRecording() {
  const { Recorder, encoderPath } = await preloadVoiceRecorder();
  const recorder = new Recorder({
    encoderPath,
    encoderApplication: 2048, // VoIP — tuned for speech
    encoderSampleRate: 48000, // Opus' native rate (Meta expects 48 kHz)
    numberOfChannels: 1,
    streamPages: false,       // one final Ogg/Opus blob delivered on stop
    monitorGain: 0,           // no self-monitoring (avoids feedback)
    recordingGain: 1,
  });

  const chunks = [];
  recorder.ondataavailable = (typedArray) => {
    if (typedArray && typedArray.length) chunks.push(typedArray);
  };

  await recorder.start();

  return {
    cancel() { try { recorder.stop(); } catch { /* already idle */ } },
    stop() {
      return new Promise((resolve) => {
        // stop() publishes the final data (ondataavailable) and THEN fires
        // onstop, so the chunks are complete by the time this resolves.
        recorder.onstop = () => resolve(chunks.length ? new Blob(chunks, { type: 'audio/ogg' }) : null);
        try { recorder.stop(); } catch { resolve(null); }
      });
    },
  };
}
