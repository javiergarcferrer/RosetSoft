# DGII e-CF certification — making AlcoverSoft a certifiable Emisor Electrónico

Goal: complete the **whole** DGII certification (Ley 32-23) with AlcoverSoft as
the declared software, so it can stand alone as the dealer's e-CF system
(retiring the prior Odoo certification). Source of truth for the process:
`Proceso de Certificación para ser Emisor Electrónico` (DGII, Jul 2025). Source
of truth for the XML formats: `Descripción Técnica de FE v1.6` + the `Formato
Acuse de Recibo (ARECF) v1.0` and `Formato Aprobación Comercial (ACECF) v1.0`
PDFs (DGII portal → Facturación → e-CF → Formatos XML).

The certification exercises the software as **both issuer and receptor**.
AlcoverSoft already had the issuer half (`ecf-send`); this effort adds the
receptor half + the test-set plumbing.

## The engine: `dgii-ecf` (pinned `@1.8.0`)

The same library `ecf-send` already deploys does the heavy crypto for BOTH
sides — we only write HTTP shells + persistence around it. Receptor surface:

- `CustomAuthentication(certs)` → `generateSeed()`, `verifySignedSeed(signedXml): Promise<token>`, `verifyToken(token): Promise<{decoded, isExpired}>`
- `SenderReceiver` → `parseMultipart(body, contentType)`, `getECFDataFromXML(xml, receptorRNC, status, code?)` → **unsigned ARECF** (we then `Signature.signXml` it)
- enums `ReceivedStatus` (`'0'` Recibido / `'1'` No Recibido), `NoReceivedCode` (`1` espec., `2` firma, `3` duplicado, `4` RNC comprador)
- `ECF.sendCommercialApproval(signedXml, fileName)` and `ECF.voidENCF(...)` (outbound)
- `certification/commercialApproval` → `genrateACECFXml(data[])` (build ACECF for the test set)
- types `IARECF` / `IACECF` describe the exact element trees.

`certs` everywhere = `new P12Reader(password).getKeyFromFile(p12Path)`, read
from the write-only `ecf_credentials` table via the service role — identical to
`ecf-send`. All new functions pin `@1.8.0` so issuer and receptor never drift on
a lib bump; **`ecf-send` is still unpinned — pin it to `@1.8.0` too** (one-line,
out of this diff's scope but recommended).

## Capability map (cert step → what it needs → status)

| Step(s) | Capability | Status | Where |
|---|---|---|---|
| reqs, 1, 13–14 | RNC/OFV/Alta NCF/cert; sign postulación + DJ | ✅ have / DGII *App Firma Digital* | — |
| 2, 4 | Issue e-CF XML → sign → send → poll TrackId | ✅ done (untested vs CerteCF) | `ecf-send`, `lib/accounting/ecfPayload.ts` |
| 2 | Generate the **prescribed test-set** XMLs, all emitted types | ⬜ TODO | task #6 |
| 3 | Generate **Aprobación/Rechazo Comercial** (outbound) + send | ⬜ TODO | task #5 |
| 5–6 | Representación impresa PDF (QR + código, ≤10MB, layout) | ⚠️ exists, needs spec check | `pdf/accounting/InvoiceDocument.tsx`, `core/accounting/invoiceDoc.js` |
| 1, 8, 9 | **Autenticación** service (semilla → token) | ✅ built | `functions/fe-autenticacion` |
| 9 | **Recepción** service (inbound e-CF → signed ARECF) | ✅ built | `functions/fe-recepcion` |
| 10–11 | **Aprobación comercial** inbound (respond OK/Error) | ✅ built | `functions/fe-aprobacioncomercial` |
| 1 | Host `soft.alcover.do/fe/*` routing | ✅ built | `vercel.json` + `config.toml` |
| 9–11 | Persist received e-CFs / approvals (business, not cert-gating) | ⬜ TODO | task #7 |

## Routing

`soft.alcover.do` → Vercel (the SPA). Its catch-all rewrite
`/((?!.*\.).*) → /index.html` would swallow `/fe/...`, so three ordered rewrites
sit **before** it and proxy to the Supabase functions of project
`jwgrjrjlhaedfathltxc` (us-west-2 "RosetSoft"):

```
/fe/autenticacion/api/:path*       → functions/v1/fe-autenticacion/:path*   (GET semilla, POST validacioncertificado)
/fe/recepcion/api/:path*           → functions/v1/fe-recepcion/:path*       (POST ecf)
/fe/aprobacioncomercial/api/:path* → functions/v1/fe-aprobacioncomercial/:path*  (POST ecf)
```

Each function inspects its sub-path (e.g. `…/semilla` vs `…/validacioncertificado`).
`config.toml` sets `verify_jwt=false` for all three (DGII sends no Supabase JWT;
auth is the semilla/token flow). These are the URLs entered in the OFV
postulación form — **do NOT enter them in production until certified; keep the
live receptor on Odoo until CerteCF passes** (issuing from AlcoverSoft never
needs them).

## Remaining work

1. **Outbound commercial approval** (#5): a Model that builds the ACECF for
   approving/rejecting a received e-CF (`genrateACECFXml` / `IACECF`) + a send
   path via `ECF.sendCommercialApproval`, with a test. Cert step 3.
2. **Issuer test-set harness** (#6): confirm every e-CF type Alcover emits
   (31/32/34 today — likely +33 nota débito; 41/43 only if it self-issues for
   purchases), extend `buildEcfPayload` for the missing ones, and add a path
   that emits XML from DGII's prescribed Excel set (exact fields/order), not
   only from quotes. Cert step 2.
3. **Persistence** (#7): additive migrations for received e-CFs + commercial
   approvals so the inbox can show them and `fe-recepcion` can detect duplicates
   (NoReceivedCode 3). Not required to PASS cert, but needed operationally.
4. **Representación impresa** (#7): validate `InvoiceDocument` against the
   *Informe Técnico* layout (mandatory fields per type, QR, código de
   seguridad, ≤10MB). Cert steps 5–6.

## CerteCF validation plan (the closing loop — run on the deployed app)

1. Configuración contable → environment **CerteCF**, re-save the cert (the env
   lives on the credential row, read by every function — see the env note in
   root CLAUDE.md / `ecfCert.js`).
2. OFV: complete the postulación with the three `/fe/*` URLs; sign + upload.
3. Run the set de pruebas: issue the test-set e-CFs (step 2), commercial
   approvals (step 3), simulation + representación impresa (steps 4–6), then
   the communication tests where DGII calls our `/fe/*` (steps 9–11).
4. Declaración jurada → authorization.

**Known spots likely to need a tweak once CerteCF responds** (cannot be tested
from the sandbox — no DGII creds): the token JSON envelope from
`validacioncertificado`; the multipart field name of the signed seed / inbound
e-CF; the ARECF signature root element; the exact aprobación-comercial ack
envelope; whether type 32 must arrive as an RFCE summary on reception. Each is
a localized change in the relevant function.

## Open inputs needed

- The exact list of **e-CF types** Alcover will emit (drives #6 + the set de pruebas).
- Confirm `soft.alcover.do` resolves to **Vercel** (assumed) — if it points
  elsewhere, the `/fe/*` rewrites move to that host.
- The DGII **Excel test set** (downloaded from the cert portal after the
  postulación validates) to wire the harness in #6.
