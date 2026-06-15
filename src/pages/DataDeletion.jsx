/**
 * Public, logged-OUT data-deletion instructions (route #/eliminar-datos).
 *
 * Satisfies Meta's "User Data Deletion" requirement for the Instagram/Facebook
 * integration: the app stores data obtained through Meta about people other than
 * the dealer — Instagram commenters' usernames + comment/mention text land in
 * `ig_events` (the Studio live feed) and WhatsApp contacts/messages live in the
 * CRM. Meta needs every such app to publish either a deletion CALLBACK or these
 * INSTRUCTIONS; we publish instructions and paste this page's URL into the App
 * Dashboard (Settings → Basic → User Data Deletion). Reviewers (and real people)
 * open it in a browser, so client-side render is fine.
 *
 * Like /tienda and /q/… it renders OUTSIDE the auth shell and is pinned LIGHT
 * (isPublicRoute, lib/theme.js + the index.html boot script). Self-contained:
 * no AppContext, no session, no fetch — just the dealer's "paper" on a visitor's
 * device. The page is its own scroll container (html/body/#root pinned in
 * index.css).
 */

const CONTACT = 'proyectos@alcover.do';
const MAILTO = `mailto:${CONTACT}?subject=${encodeURIComponent('Eliminación de datos')}`;

export default function DataDeletion() {
  return (
    <div className="min-h-full overflow-y-auto bg-[#f4f0e8] text-ink-900">
      {/* Slim, centered wordmark — mirrors the storefront chrome. */}
      <header className="border-b border-ink-900/10">
        <div className="mx-auto max-w-2xl px-6 py-5 text-center">
          <div className="font-wordmark text-xl tracking-wide text-ink-900">ALCOVER</div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-6 py-12 sm:py-16">
        <div className="eyebrow">Privacidad</div>
        <h1 className="mt-2 font-display text-3xl font-normal leading-tight tracking-tight sm:text-4xl">
          Eliminación de datos
        </h1>

        {/* ---- Español ---- */}
        <section className="mt-8 space-y-5 text-[15px] leading-relaxed text-ink-700">
          <p>
            En <strong className="text-ink-900">ALCOVER</strong> respetamos tu privacidad. Si has
            interactuado con nosotros en Instagram, Facebook o WhatsApp, puedes pedir que eliminemos
            los datos que tengamos sobre ti. No necesitas tener una cuenta con nosotros.
          </p>

          <div>
            <h2 className="font-display text-lg text-ink-900">Qué datos conservamos</h2>
            <p className="mt-2">
              A través de las plataformas de Meta podemos guardar:
            </p>
            <ul className="mt-3 space-y-2 pl-5">
              <li className="list-disc marker:text-ink-400">
                Tu <strong className="text-ink-900">nombre de usuario de Instagram</strong> y el texto
                de los comentarios o menciones que dejes en nuestras publicaciones.
              </li>
              <li className="list-disc marker:text-ink-400">
                Los <strong className="text-ink-900">mensajes y el número de contacto</strong> de las
                conversaciones que inicies con nosotros por WhatsApp.
              </li>
            </ul>
          </div>

          <div>
            <h2 className="font-display text-lg text-ink-900">Cómo solicitar la eliminación</h2>
            <p className="mt-2">
              Escríbenos a{' '}
              <a className="font-medium text-ink-900 underline decoration-ink-300 underline-offset-2" href={MAILTO}>
                {CONTACT}
              </a>{' '}
              con el asunto <span className="whitespace-nowrap">«Eliminación de datos»</span> e incluye
              tu nombre de usuario de Instagram o el número de WhatsApp asociado, para poder localizar
              tu información.
            </p>
          </div>

          <div>
            <h2 className="font-display text-lg text-ink-900">Qué ocurre después</h2>
            <p className="mt-2">
              Confirmaremos tu solicitud y eliminaremos esos datos de nuestros sistemas en un plazo
              máximo de <strong className="text-ink-900">30 días</strong>, salvo la información que la
              ley dominicana nos obligue a conservar (por ejemplo, los registros fiscales de una compra).
            </p>
          </div>
        </section>

        {/* ---- English mirror (reviewers / non-Spanish speakers) ---- */}
        <section className="mt-12 border-t border-ink-900/10 pt-8 space-y-4 text-[14px] leading-relaxed text-ink-600">
          <div className="eyebrow">In English</div>
          <p>
            <strong className="text-ink-900">ALCOVER</strong> respects your privacy. If you have
            interacted with us on Instagram, Facebook or WhatsApp, you may request deletion of the
            data we hold about you — you don't need an account with us.
          </p>
          <p>
            Through Meta's platforms we may store your{' '}
            <strong className="text-ink-900">Instagram username</strong> and the text of comments or
            mentions you leave on our posts, and the{' '}
            <strong className="text-ink-900">messages and contact number</strong> of WhatsApp
            conversations you start with us.
          </p>
          <p>
            To request deletion, email{' '}
            <a className="font-medium text-ink-900 underline decoration-ink-300 underline-offset-2" href={MAILTO}>
              {CONTACT}
            </a>{' '}
            with the subject <span className="whitespace-nowrap">"Data deletion"</span>, including your
            Instagram username or the associated WhatsApp number. We will confirm your request and
            erase that data within <strong className="text-ink-900">30 days</strong>, except records we
            are legally required to keep (such as tax records of a purchase).
          </p>
        </section>

        <footer className="mt-12 border-t border-ink-900/10 pt-6 text-[13px] text-ink-500">
          ALCOVER · Santo Domingo, República Dominicana ·{' '}
          <a className="underline decoration-ink-300 underline-offset-2" href={MAILTO}>{CONTACT}</a>
        </footer>
      </main>
    </div>
  );
}
