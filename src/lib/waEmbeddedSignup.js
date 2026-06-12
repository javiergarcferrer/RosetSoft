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

  const session = { phoneNumberId: '', wabaId: '' };
  const onMessage = (event) => {
    if (!/facebook\.com$/.test(String(event.origin || ''))) return;
    try {
      const data = JSON.parse(event.data);
      if (data?.type === 'WA_EMBEDDED_SIGNUP' && data.data) {
        session.phoneNumberId = String(data.data.phone_number_id || session.phoneNumberId);
        session.wabaId = String(data.data.waba_id || session.wabaId);
      }
    } catch { /* non-JSON frame chatter — ignore */ }
  };
  window.addEventListener('message', onMessage);

  try {
    const code = await new Promise((resolve, reject) => {
      FB.login((resp) => {
        const c = resp?.authResponse?.code;
        if (c) resolve(c);
        else reject(new Error('Conexión cancelada en el diálogo de Meta.'));
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
