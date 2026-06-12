import { useState } from 'react';

/**
 * The ONE input for credential/secret fields (API tokens, client ids/secrets,
 * account ids) with every measure that actually stops autofill — browsers
 * ignore plain autocomplete="off" on anything that looks like a login form,
 * which is how a saved email/password ended up SAVED as WhatsApp/Shopify
 * credentials. Belt and braces:
 *
 *   • readOnly until first focus — password managers don't fill read-only
 *     inputs at page load, and heuristic "login form" fills skip them. The
 *     first real user focus unlocks typing/pasting.
 *   • autocomplete="new-password" on secrets (the only value Chrome/Safari
 *     honor on password-type inputs), "off" on the rest.
 *   • the documented opt-outs for the password-manager extensions:
 *     data-1p-ignore (1Password), data-lpignore (LastPass), data-bwignore
 *     (Bitwarden), data-form-type="other" (Dashlane).
 *   • no autocapitalize/autocorrect/spellcheck — credentials are pasted
 *     verbatim, never "corrected".
 *
 * Pair with non-credential `name`s and, where something is already saved,
 * with the locked-section pattern (don't render the inputs at all until an
 * explicit "Editar credenciales").
 */
export default function CredentialInput({ secret = false, onFocus, ...props }) {
  const [touched, setTouched] = useState(false);
  return (
    <input
      type={secret ? 'password' : 'text'}
      {...props}
      readOnly={!touched}
      onFocus={(e) => { setTouched(true); onFocus?.(e); }}
      autoComplete={secret ? 'new-password' : 'off'}
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      data-1p-ignore="true"
      data-lpignore="true"
      data-bwignore="true"
      data-form-type="other"
    />
  );
}
