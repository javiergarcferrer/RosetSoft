// Meta Embedded Signup, COEXISTENCE flavor — the browser side.
//
// Coexistence links a number that lives on the phone's WhatsApp Business app
// to the Cloud API WITHOUT disconnecting the app: Meta's hosted dialog walks
// the dealer through scanning a QR from the phone, then hands back a one-time
// auth code (and the onboarded ids via postMessage). The code is exchanged
// server-side by wa-send's `onboard` action — the App Secret never leaves the
// server. Needs two NON-secret launch ids saved in Settings: the Meta App ID
// and the Facebook Login for Business Configuration ID.

let sdkPromise = null;

function loadFbSdk(appId) {
  if (typeof window !== 'undefined' && window.FB) return Promise.resolve(window.FB);
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      window.fbAsyncInit = () => {
        window.FB.init({ appId, autoLogAppEvents: false, xfbml: false, version: 'v23.0' });
        resolve(window.FB);
      };
      const s = document.createElement('script');
      s.src = 'https://connect.facebook.net/en_US/sdk.js';
      s.async = true;
      s.defer = true;
      s.crossOrigin = 'anonymous';
      s.onerror = () => reject(new Error('No se pudo cargar el SDK de Meta (revisa bloqueadores de anuncios o la conexión).'));
      document.head.appendChild(s);
    });
  }
  return sdkPromise;
}

/**
 * Launch the coexistence Embedded Signup dialog and resolve with what the
 * server exchange needs: { code, phoneNumberId, wabaId }. The ids arrive via
 * the dialog's postMessage (session info); the code via FB.login's response.
 * Rejects when the dealer closes/cancels the dialog or the SDK can't load.
 */
export async function runCoexistenceSignup({ appId, configId }) {
  if (!appId || !configId) {
    throw new Error('Faltan el App ID y el Configuration ID de Meta — guárdalos primero en esta tarjeta.');
  }
  const FB = await loadFbSdk(appId);

  // Session logging (Meta's required Embedded Signup pattern): capture EVERY
  // WA_EMBEDDED_SIGNUP postMessage — the onboarded ids, the step the dealer
  // reached, and the terminal event (FINISH / CANCEL / ERROR). Logged for
  // debugging and used to give a precise reason when the dialog doesn't finish.
  const session = { phoneNumberId: '', wabaId: '', currentStep: '', event: '', errorMessage: '' };
  const onMessage = (event) => {
    if (!/facebook\.com$/.test(String(event.origin || ''))) return;
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; } // non-JSON frame chatter
    if (payload?.type !== 'WA_EMBEDDED_SIGNUP') return;
    console.log('[wa-embedded-signup] session', payload); // session logging
    if (payload.event) session.event = String(payload.event);
    const d = payload.data || {};
    if (d.phone_number_id) session.phoneNumberId = String(d.phone_number_id);
    if (d.waba_id) session.wabaId = String(d.waba_id);
    if (d.current_step) session.currentStep = String(d.current_step);
    if (d.error_message) session.errorMessage = String(d.error_message);
  };
  window.addEventListener('message', onMessage);

  try {
    const code = await new Promise((resolve, reject) => {
      FB.login((resp) => {
        const c = resp?.authResponse?.code;
        if (c) { resolve(c); return; }
        // No code → the dialog was cancelled or errored. Use the logged session
        // event for a precise reason instead of a generic "cancelled".
        if (session.event === 'ERROR' || session.errorMessage) {
          reject(new Error(session.errorMessage || 'Meta reportó un error en el diálogo de Embedded Signup.'));
        } else {
          reject(new Error(`Conexión cancelada en el diálogo de Meta${session.currentStep ? ` (paso: ${session.currentStep})` : ''}.`));
        }
      }, {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: {
          setup: {},
          // The coexistence onboarding flow: keep the number on the phone app
          // and link it to the Cloud API via QR scan.
          featureType: 'whatsapp_business_app_onboarding',
          sessionInfoVersion: '3',
        },
      });
    });
    return { code, phoneNumberId: session.phoneNumberId, wabaId: session.wabaId };
  } finally {
    window.removeEventListener('message', onMessage);
  }
}
