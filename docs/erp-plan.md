# Plan: convertir RosetSoft en ERP contable (RD)

Estado: **en implementación.** Fases 1, 2a y 2b construidas y verificadas
(typecheck + build + tests). Rama: `claude/intelligent-planck-A1SbE`.

## Decisiones confirmadas por el dueño (parámetros bloqueados)
- **Sin operaciones exentas** → el ITBIS de compras/gastos es 100% crédito (sin
  proporcionalidad).
- **ITBIS 18%**; **gravamen arancelario 20%** en mercancía (99% de los casos).
- **Se factura al ENTREGAR el mobiliario** → ingreso/NCF se reconocen en la entrega.
- **Agente de retención por proveedor**: se retiene sólo cuando el proveedor lo
  requiere (banderas `retainIsr`/`retainItbis` por proveedor).
- **Depósitos de cliente** financian la compra de mercancía → pasivo (cobros
  anticipados) hasta la entrega.
- **Pasarelas de pago** (CardNet/VisaNet/Azul…): comisión + sus particularidades.
- **eNCF: integración directa con la DGII** (e-CF) — ver §6/§eNCF.

## Estado de implementación
- **✅ Fase 1 — Cimientos (libro mayor + catálogo).** Tablas `accounts` (251
  cuentas sembradas), `journal_entries`, `journal_lines`. Motor de partida doble
  (`assertBalanced`, `buildJournalEntry`). Vistas: Libro contable (Diario con
  alta de asientos, Mayor, Balanza), Estados financieros (Balance General +
  Estado de Resultados), Catálogo de cuentas. 21 tests.
- **✅ Fase 2a — Configuración fiscal.** Parámetros (ITBIS 18, gravamen 20,
  retenciones) + mapa de cuentas (rol→código) con defaults reales del catálogo.
  Página Configuración contable. 5 tests.
- **✅ Fase 2b — Gastos + Proveedores + 606.** Captura de gasto que se asienta
  solo (gasto + ITBIS adelantado / banco-caja-suplidores / retenciones), CRUD de
  proveedores con banderas de retención, reporte 606 con export CSV. 9 tests.
- **✅ Fase 3 — Facturación @ entrega + 607 + IT-1.** Postea la venta al entregar
  (aplica el depósito, reconoce CxC + ventas + ITBIS), 607 con export CSV, y la
  liquidación de ITBIS (débito ventas − crédito compras/gastos/importación). 8 tests.
- **✅ Fase 4 — Compras + Inventario + costeo.** Compra (mercancía→inventario,
  activo/servicio→cuenta) que se asienta sola y alimenta el 606; inventario con
  kardex de promedio ponderado; salida que postea Costo de venta. 8 tests.
- **✅ Fase 5 — Importación / liquidación DGA.** CIF + gravamen (20%) + despacho →
  costo en destino capitalizado; ITBIS de importación como crédito; entrada al
  inventario al costo unitario en destino. 5 tests.
- **✅ Búsqueda de RNC/cédula (DGII)** — Edge Function `rnc-lookup` + autocompletar
  el nombre fiscal en proveedores y en Facturación (607). 3 tests.
- **⏳ Fase 6 — IR-2 anual** (el Balance General + Estado de Resultados ya están).
- **🟡 Track eNCF — en progreso.** ✅ Secuencias e-NCF (rangos autorizados por
  tipo, asignación del próximo al facturar, página de gestión) + ✅ constructor
  del payload e-CF (JSON 1.0 para tipos 31/32, listo para `json2xml`). ⏳ Falta
  firmar + transmitir a la DGII (Edge Function con la lib `dgii-ecf`), que
  **requiere el certificado digital .p12 del cliente** (ver §eNCF). 10 tests.
- **⏳ Costo de venta automático por venta** (hoy la salida de inventario se
  registra manualmente; atar cada venta a sus SKU es un paso deliberado posterior).

**Audiencia doble:**
- **Asesor financiero / contador** → revisa el §4 (asientos), §6 (formularios
  DGII), §10 (decisiones que necesito de ti) y §11 (observaciones del catálogo).
- **Sesión de ingeniería futura** → §2, §3, §7, §8, §9 (modelo de datos,
  arquitectura, fases).

Base de partida: el archivo `CATALOGO_DE_CUENTAS.xlsx` (256 cuentas, hoja `BAL`,
alineado al **IR‑2** de la DGII y sus anexos A‑1, B‑1, D‑2). Códigos de cuenta con
formato jerárquico `X‑XX‑XXX‑XX‑XX‑XX`, 6 clases: 1 Activos · 2 Pasivos ·
3 Patrimonio · 4 Ingresos · 5 Costos · 6 Gastos.

---

## §0 — Veredicto y principio rector

Sí es viable, y la app encaja bien porque su arquitectura (MVVM, "la Vista no
deriva nada", todo es `resolveX(rows)`) es **la misma forma** que un sistema
contable: estados financieros y formularios fiscales = proyecciones de un libro
mayor.

**Principio rector (una sola idea):** cada evento de negocio genera un **asiento
de partida doble** (Debe = Haber) que postea a las cuentas de *este* catálogo.
El **libro mayor es la única fuente de verdad**. Todo lo demás —Balance General,
Estado de Resultados, 606, 607, IT‑1, IR‑2— se *deriva* del mayor. No se captura
dos veces.

Ventaja estructural: RosetSoft es **mono‑empresa** (un solo perfil `team`), así
que no hay complejidad multi‑compañía. Un catálogo, un mayor.

---

## §1 — Arquitectura conceptual

```
Evento de negocio            Asiento (Debe=Haber)        Mayor              Proyecciones
─────────────────            ────────────────────        ─────              ────────────
Venta / Compra / Gasto  ──▶  journal_entries        ──▶  saldos por    ──▶  Balance General
Importación / Aduana         + journal_lines             cuenta y           Estado de Resultados
Cobro / Pago                 (postea al catálogo)        período            606 / 607 / 608
Depreciación / Nómina                                                       IT‑1 / IR‑17 / IR‑2
```

Reglas invariantes del motor:
1. Un asiento sólo se guarda si **Σ Debe = Σ Haber** (validación dura).
2. Sólo postean las **cuentas hoja** (sin hijas); las cuentas título sólo suman.
3. Los asientos **no se borran**: se **reversan** con un contra‑asiento (auditoría).
4. Período cerrado ⇒ **bloqueado** (no admite asientos nuevos ni ediciones).
5. Moneda funcional/fiscal = **DOP**; la operación es en USD → cada asiento
   guarda monto USD, tasa y monto DOP. La revaluación de saldos en USD produce
   **diferencia cambiaria** (ganancia `4‑03‑003` / pérdida `6‑08‑005`).

---

## §2 — El catálogo de cuentas como dato

Nueva tabla `accounts`, sembrada con las 256 filas del Excel:

| Columna | Significado |
|---|---|
| `code` | `1‑01‑001‑01‑00‑00` (clave de negocio, único) |
| `name` | "CAJA GENERAL" |
| `parentCode` | derivado del código (jerarquía) |
| `class` | 1..6 (primer segmento) |
| `nature` | `debit` (clases 1,5,6) / `credit` (clases 2,3,4) — para signo de saldo |
| `isPostable` | `true` sólo en hojas (sin hijas). Sólo estas reciben asientos |
| `level` | profundidad para la sangría del reporte |
| `dgiiBox` | casilla del formulario destino (mapeo IR‑2/IT‑1) — se llena con el asesor |

Notas:
- "NOMBRE DEL INGRESO" (`4‑01‑001‑02`…`09`) y "GASTO DISPONIBLE"
  (`6‑02‑007‑12`…`18`) son **placeholders** que el asesor renombra a las cuentas
  reales del negocio (p. ej. "VENTA DE MOBILIARIO", "FLETES Y ENTREGAS").
- La siembra es una migración idempotente (`insert … on conflict (code) do
  update`), así que regenerar el catálogo no duplica.

---

## §3 — Modelo de datos nuevo (tablas)

Todas siguen las convenciones del proyecto: PK `text` (`newId()`), single‑tenant
(`profileId = 'team'`), RLS "team can write", camelCase↔snake automático,
`*At` en milisegundos. Migraciones aditivas e idempotentes.

| Tabla | Para qué | Columnas clave |
|---|---|---|
| `accounts` | el catálogo (§2) | code, name, nature, isPostable |
| `fiscal_periods` | meses contables + cierre | year, month, status (`open`/`closed`) |
| `journal_entries` | cabecera de asiento | date, memo, source (`sale`/`purchase`/`expense`/`import`/`payment`/`manual`), refId, reversedById |
| `journal_lines` | líneas del asiento | entryId, accountCode, debit, credit, usd, rate, thirdPartyId, ncf |
| `suppliers` | proveedores | rnc, name, kind (`fisica`/`juridica`/`exterior`), retentionProfile |
| `purchases` | compra de mercancía/activo | supplierId, ncf, date, currency, lines, itbis, retentions |
| `expenses` | gasto operativo (clase 6) | supplierId, ncf, accountCode, base, itbis, retISR, retITBIS, paidFrom |
| `inventory_items` | artículo de stock | sku, name, qtyOnHand, avgCost (costeo) |
| `inventory_movements` | kardex (entradas/salidas) | itemId, type (`in`/`out`/`adjust`), qty, unitCost, refId |
| `import_liquidations` | liquidación DGA (§5) | orderId, cif, freight, insurance, dutyAmount, importItbis, clearanceFees |
| `tax_filings` | 606/607/608/IT‑1/IR‑17 generados | type, period, status, payload |
| `ncf_sequences` | control de comprobantes propios (ventas) | type, prefix, next, expiresAt |

Reutiliza lo existente: `customers`, `professionals`, `orders`, `containers`,
`quotes`/`quote_lines` (la venta), `settings` (tasa USD↔DOP, datos de la empresa).

---

## §4 — Catálogo de asientos por evento ⟵ EL CORAZÓN (validar con el asesor)

Para cada evento, el asiento con **cuentas reales de tu catálogo**. Las tasas
(% de ITBIS, % de retención) van marcadas `[confirmar]` porque son decisión del
asesor (§10).

### 4.1 Venta local con ITBIS (cotización aceptada → factura con NCF)
La cotización aceptada ya lleva base imponible e ITBIS (`taxAmt`).

| Cuenta | Debe | Haber |
|---|---|---|
| `1‑01‑002` CxC Clientes (o `1‑01‑001‑02` Banco si es de contado) | Total | |
| `4‑01‑001‑01` Ventas locales | | Base |
| `2‑01‑003‑01` ITBIS por pagar | | ITBIS [18% confirmar] |

Y el **costo** de lo vendido (sale del inventario al costo promedio):

| Cuenta | Debe | Haber |
|---|---|---|
| `5‑01` Costo de venta | Costo | |
| `1‑01‑005` Inventario productos terminados | | Costo |

→ alimenta **607** (ventas) e **IT‑1** (débito fiscal).
**A decidir (§10):** ¿cuándo nace la factura/NCF? ¿al aceptar, al depósito o a la
**entrega**? En venta de mueble importado lo normal es a la entrega.

### 4.2 Depósito / anticipo del cliente (antes de entregar)
RosetSoft ya registra `depositReceivedAt` + `depositAmount`. Como la mercancía
se importa (plazo largo), el depósito es un **pasivo**, no un ingreso, hasta la
entrega:

| Cuenta | Debe | Haber |
|---|---|---|
| `1‑01‑001‑02` Banco | Depósito | |
| `2‑01‑005` Cobros anticipados | | Depósito |

Al entregar/facturar (4.1) se cancela `2‑01‑005` contra `1‑01‑002` CxC.

### 4.3 Compra de mercancía a suplidor local (con ITBIS y retención)

| Cuenta | Debe | Haber |
|---|---|---|
| `1‑01‑005` Inventario | Base | |
| `1‑04‑002‑06` ITBIS adelantado en compras | ITBIS | |
| `2‑01‑002‑01` Suplidores | | Neto a pagar |
| `2‑01‑003‑02` ITBIS retenido (si aplica) | | Ret. ITBIS [confirmar] |
| `2‑01‑003‑0x` Retención ISR (si aplica) | | Ret. ISR [confirmar] |

→ alimenta **606** (compras) e **IR‑17** (retenciones) e **IT‑1** (crédito fiscal).

### 4.4 Importación (Ligne Roset) + liquidación DGA — ver §5 en detalle
Resumen del ciclo:
1. **En tránsito** (orden `in_transit`): `1‑01‑009` Mercancías en tránsito (Debe)
   contra `2‑01‑002‑01` Suplidor exterior / Banco (Haber).
2. **Liquidación aduanal** (orden `in_customs`): gravámenes + flete + seguro +
   despacho se **capitalizan** (Debe `1‑01‑009`); el ITBIS de importación es
   crédito (Debe `1‑04‑002‑06`); contra Banco / agente aduanal (Haber).
3. **Recepción** (orden `received`): traslado a inventario disponible al **costo
   en destino**: `1‑01‑005` (Debe) contra `1‑01‑009` (Haber).

### 4.5 Gasto operativo (servicios, utilities, alquiler…)

| Cuenta | Debe | Haber |
|---|---|---|
| `6‑xx‑…` Gasto (p. ej. `6‑02‑007‑01‑03` Teléfono e Internet) | Base | |
| `1‑04‑002‑06` ITBIS adelantado (si tiene derecho a crédito) | ITBIS | |
| `1‑01‑001‑02` Banco (o `2‑01‑002` CxP) | | Neto |
| `2‑01‑003‑0x` Retención ISR/ITBIS (si aplica) | | Retención [confirmar] |

→ alimenta **606** e **IR‑17**.
Si el gasto es de **operación exenta**, el ITBIS NO es crédito y va al gasto
(cuentas "ITBIS pagado en operaciones exentas": `6‑02‑008`, `6‑03‑004`,
`6‑04‑009`, `6‑05‑008`) — ver §11 sobre proporcionalidad.

### 4.6 Nómina (clase 6‑01)

| Cuenta | Debe | Haber |
|---|---|---|
| `6‑01‑001‑01` Salarios y comisiones | Bruto | |
| `2‑01‑004‑01` Nóminas por pagar | | Neto |
| `2‑01‑003‑04` TSS (retención + aporte) | | TSS |
| `2‑01‑003‑05` INFOTEP | | INFOTEP |
| `2‑01‑003‑07` IR‑17 (retención asalariados) | | ISR empleados |

Aportes patronales: `6‑01‑005` Seguridad social y `6‑01‑006` INFOTEP (Debe)
contra los pasivos `2‑01‑003‑04/05`.

### 4.7 Depreciación mensual

| Cuenta | Debe | Haber |
|---|---|---|
| `6‑04‑001/002/003` Depreciación categoría #1/#2/#3 | Cuota | |
| `1‑05‑001/003/004` Depreciación acumulada | | Cuota |

### 4.8 Comisiones (lo que ya calcula la app)
La app ya deriva comisión de vendedor y de profesional (`core/accounting/
sales.js`). Su pago se asienta:

| Cuenta | Debe | Haber |
|---|---|---|
| `6‑01‑001‑01` Salarios y comisiones (vendedor) | Comisión | |
| `1‑01‑001‑02` Banco | | Pago |

(El "trade discount" al decorador es un descuento en factura, no gasto — se
modela como menor ingreso, no como comisión.)

### 4.9 Liquidación mensual de ITBIS (IT‑1) — asiento de cierre
ITBIS por pagar (ventas) − ITBIS adelantado (compras/gastos) − retenciones que
nos hicieron = saldo a pagar o saldo a favor.

| Cuenta | Debe | Haber |
|---|---|---|
| `2‑01‑003‑01` ITBIS por pagar | Débito fiscal del mes | |
| `1‑04‑002‑06` ITBIS adelantado | | Crédito fiscal del mes |
| `1‑01‑001‑02` Banco (pago) **o** `1‑04‑002‑04` Saldo a favor | Saldo | Saldo |

---

## §5 — Liquidación DGA (importaciones) en detalle

La app ya modela la importación física (orden `in_transit → in_customs →
received`, contenedores, puertos, tracking de travesía). Falta capturar **los
números** de la liquidación aduanal y convertirlos en **costo en destino**
(landed cost).

Entradas a capturar en `import_liquidations` (por orden/embarque):
- **Valor CIF** (FOB + flete + seguro).
- **Gravamen arancelario** (según partida arancelaria; el mueble suele tener
  arancel — el asesor/agente confirma la tasa por partida).
- **ITBIS de importación** (18% sobre CIF + gravamen + selectivo, si aplica) —
  es **crédito fiscal** `1‑04‑002‑06`, no costo.
- **Selectivo al consumo** (si aplicara) — costo.
- **Servicios de despacho / agente aduanal / tasas** — costo.

Algoritmo de **prorrateo (landed cost)**: distribuir gravamen + flete + seguro +
despacho entre las líneas/SKU del embarque (por valor FOB o por volumen) para
obtener el costo unitario en destino que entra al inventario. *(Este prorrateo es
una pieza de cálculo nueva, con su test de dinero.)*

Resultado: el `avgCost` del inventario refleja el **costo real puesto en RD**, no
sólo el FOB — así el `5‑01` Costo de venta y el margen son correctos.

---

## §6 — Liquidación DGII (formularios) = proyecciones del mayor

Ninguno es captura nueva: todos se *derivan* de los asientos + terceros + NCF.

| Formulario | Qué es | Se deriva de |
|---|---|---|
| **606** | Compras de bienes y servicios (con NCF de proveedor) | `purchases` + `expenses` |
| **607** | Ventas de bienes y servicios (NCF propios) | ventas (4.1) |
| **608** | Comprobantes fiscales anulados | NCF anulados |
| **IT‑1** | Declaración mensual de ITBIS | 606 + 607 + arrastre saldo a favor |
| **IR‑17** | Otras retenciones (terceros, exterior) | retenciones de 4.3/4.5/4.6 |
| **IR‑2** | Declaración jurada anual de ISR (sociedades) + anexos | mayor del ejercicio |
| **Balance (este Excel)** | Estado de Situación a la fecha | saldos clases 1/2/3 |

**A decidir (§10):** formato exacto de envío a DGII (TXT/Excel de la Oficina
Virtual, e‑CF si aplican comprobante fiscal electrónico). El motor produce los
datos; el formato del archivo lo fijamos con el asesor.

---

## §7 — Estados financieros y libros

Todos `resolveX(journalLines, periodo)`:
- **Balanza de comprobación** — saldo deudor/acreedor por cuenta hoja, cuadra.
- **Libro Diario** — asientos cronológicos.
- **Libro Mayor** — movimientos y saldo por cuenta.
- **Estado de Resultados** — clases 4 (ingresos) − 5 (costos) − 6 (gastos) del
  período → utilidad → `3‑05` Resultados del período.
- **Balance General** — clases 1/2/3 a una fecha. **Es literalmente la hoja `BAL`
  de tu Excel**, generada automáticamente.

---

## §8 — Encaje con la arquitectura de RosetSoft

| Capa | Qué se agrega |
|---|---|
| **Model** `src/lib/accounting/*` | `postEntry` (valida Debe=Haber), `accountBalance`, `averageCost`, `landedCost`, `itbisLiquidation`, `retention` — puro, testeable, sin React/Supabase |
| **ViewModel** `src/core/accounting/*` | `resolveLedger`, `resolveTrialBalance`, `resolveBalanceSheet`, `resolveIncomeStatement`, `resolve606`, `resolve607`, `resolveITBIS` (junto al `resolveSales` existente) |
| **View** `src/pages/accounting/*` | pestañas nuevas en el workspace de Contabilidad (ya existe el rol `accounting` y la página) |
| **DB** | migraciones aditivas (§3) + siembra del catálogo; el mapeo camelCase↔snake es automático |
| **Tests** | encaja con la política del proyecto: tests sólo de dinero/parsing/integridad → `postEntry` (cuadre), `averageCost`, `landedCost`, `itbisLiquidation`, `retention` |
| **Edge Function** (opcional) | validación server‑side del cierre de período / numeración NCF, si se requiere autoridad de servidor |

Despliegue: push a `main` aplica migraciones y deploya solo — **ningún paso
manual** para el usuario.

---

## §9 — Fases y entregables (cada una se shippea sola)

1. **Cimientos** — tabla `accounts` + siembra del catálogo + `journal_entries`/
   `journal_lines` + `postEntry` + vistas Libro Diario / Mayor / Balanza.
   *Hecho =* puedo registrar un asiento manual y ver el mayor cuadrado.
2. **Ventas → 607 + IT‑1** — la cotización aceptada emite su asiento (4.1) y
   alimenta el 607 y el débito fiscal. *(Aprovecha lo casi listo.)*
3. **Gastos → 606** — módulo de gastos (4.5) con NCF/ITBIS/retención.
4. **Compras + Inventario + costeo** — proveedores, compra (4.3), kardex,
   costo promedio, costo de venta (4.1 costo).
5. **Liquidación DGA** — `import_liquidations` + prorrateo landed cost sobre el
   flujo de importación existente (§5).
6. **Estados financieros + IR‑2** — Balance General (tu Excel), Estado de
   Resultados, e IR‑2 anual.

---

## §10 — Decisiones que necesito del asesor ⚑ (checklist para la reunión)

1. **Postabilidad y naturaleza** de las cuentas hoja — confirmar que la regla
   "sólo hojas postean, signo por clase" es correcta para este catálogo.
2. **Renombrar placeholders**: "NOMBRE DEL INGRESO" (`4‑01‑001‑02..09`) y "GASTO
   DISPONIBLE" (`6‑02‑007‑12..18`) → cuentas reales del negocio.
3. **Momento del hecho generador / NCF de venta**: ¿se factura al aceptar, al
   depósito o a la **entrega**? (define cuándo entra al 607 y al ITBIS).
4. **Retenciones**: ¿la empresa es agente de retención? Tasas aplicables de ISR
   (honorarios, servicios, gubernamental 5%, etc.) y de ITBIS (a personas
   físicas / profesionales). Qué proveedores se retiene.
5. **Costeo de inventario**: ¿promedio ponderado? (sugerido, aceptado por DGII).
6. **Depósito de cliente**: confirmar tratamiento como `2‑01‑005` Cobros
   anticipados hasta la entrega (vs. ingreso inmediato).
7. **ITBIS en importación y proporcionalidad**: el catálogo tiene `6‑01‑008`
   "ITBIS llevado a la proporcionalidad" y varias "ITBIS pagado en operaciones
   exentas" → ¿la empresa tiene operaciones exentas y aplica proporcionalidad del
   crédito? (impacta 4.5).
8. **Formato exacto de envío** de 606 / 607 / 608 / IT‑1 (Oficina Virtual) y si
   usan **e‑CF** (comprobante fiscal electrónico).
9. **ISR / anticipos**: periodicidad de anticipos, manejo de `2‑01‑003‑03`
   Anticipo ISR y `1‑04‑002‑02` Anticipo por compensar.
10. **Impuesto a los Activos** (`2‑01‑003‑10` / `6‑08‑007`): ¿aplica el 1%?
11. **Moneda fiscal**: confirmar reexpresión a DOP y tratamiento de la diferencia
    cambiaria (`4‑03‑003` / `6‑08‑005`) sobre saldos en USD.

---

## §11 — Observaciones del catálogo (lo que el archivo ya revela)

- **Operaciones exentas + proporcionalidad de ITBIS**: la presencia de `6‑01‑008`
  "ITBIS llevado a la proporcionalidad" y de "ITBIS pagado en operaciones exentas"
  en gastos, arrendamientos, activos fijos y representación indica que el catálogo
  contempla que **no todo el ITBIS de compras es crédito**. Hay que modelar el
  prorrateo del crédito (gravado vs. exento) — confirmar §10.7.
- **Mercancías en tránsito (`1‑01‑009`)** ya existe → mapea exactamente al flujo
  de importación `in_transit` de la app. El catálogo fue pensado para una empresa
  que **importa**.
- **Impuesto a los Activos** (`2‑01‑003‑10`, `6‑08‑007`) → contemplar el 1% como
  mínimo alternativo del ISR.
- **Retención bancaria 0.15%** (`6‑07‑008`) y comisiones de tarjetas
  (`6‑07‑010‑02`: CardNet, VisaNet, Amex, Blue) → gastos financieros recurrentes
  fáciles de automatizar desde la conciliación de cobros con tarjeta.
- **Anticipo ISR por compensar** (`1‑04‑002‑02`) y saldos a favor (`1‑04‑002‑04`)
  → el motor debe arrastrar saldos a favor entre períodos.

---

## §12 — Riesgos y fuera de alcance (versión 1)

- **No es un fin de semana.** Es un sistema contable real; bien hecho son las 6
  fases del §9. Lo bueno: cada fase aporta valor sola.
- **Cumplimiento es responsabilidad compartida**: el motor lo construyo; las
  reglas fiscales exactas (tasas, formatos, aplicabilidad) las firma el asesor.
- **Fuera de alcance v1** (posibles fases futuras): conciliación bancaria
  automática, módulo detallado de activos fijos con cédulas de depreciación,
  presupuestos, multi‑sucursal (no aplica, mono‑empresa), e‑CF en tiempo real si
  no lo exigen aún.

---

## §eNCF — integración e-CF con la DGII (track propio)

El dueño quiere **emisión directa de e-CF**. Lo que el código construye y lo que
es dependencia externa inevitable:

**Construible en la app (sin pasos manuales de despliegue):**
- Secuencias de eNCF por tipo (31 crédito fiscal, 32 consumo, 34 nota de crédito…)
  con control de rango y vencimiento.
- Generación del XML del e-CF según el estándar DGII, a partir de la venta/asiento.
- Firma + envío vía Edge Function (Deno) a los web services de la DGII (ambiente
  de certificación `Cert-eCF` y producción), y registro del **acuse/aprobación**
  (track number, estado) en la venta.
- Representación impresa (RFCE) con su código QR.

**Dependencia externa inevitable (no la elimina ningún código):**
- **Certificado digital** vigente de una entidad autorizada (p. ej. Avansi/Camara
  de Comercio) + **inscripción como emisor electrónico** en la DGII. El cliente
  lo **sube una vez en Configuración** (acción de app, NO un paso de despliegue);
  a partir de ahí, todo es automático. Sin ese certificado no se puede firmar/
  transmitir, y construir el XML "a ciegas" sin la WSDL/certificado de prueba
  produciría comprobantes no conformes — por eso este track se hace contra el
  ambiente de certificación con el certificado real.

## Do NOT (para la sesión de implementación)

- No empezar por los formularios DGII antes de tener el mayor (§9 fase 1 primero).
- No capturar ITBIS/ingresos/costos por fuera del asiento — **todo pasa por
  `journal_lines`** o se duplica la verdad.
- No back‑datear migraciones (rompe la cadena `supabase db push`); timestamp
  posterior a la última migración existente.
- No hard‑codear tasas (ITBIS, retención) en el Model — son parámetros de
  `settings` para que el asesor las ajuste sin recompilar.
