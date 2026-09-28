# Context - App Shopify Importador de Productos

## URLs de Documentación Shopify (Acceso rápido)

### Core Obligatorio
- Scaffold App: https://shopify.dev/docs/apps/build/scaffold-app
- Admin GraphQL API: https://shopify.dev/docs/api/admin-graphql
- Autenticación: https://shopify.dev/docs/apps/build/authentication-authorization
- App Bridge: https://shopify.dev/docs/api/app-bridge
- Bulk Operations (imports): https://shopify.dev/docs/api/usage/bulk-operations/imports
- Bulk Operations (queries, listar `bulkOperations`): https://shopify.dev/docs/api/usage/bulk-operations/queries

### UI - Polaris React (App Embebida)
- Componentes: https://polaris.shopify.com/components
- Tokens: https://polaris.shopify.com/tokens

### CLI y Toolkit
- Shopify CLI: https://shopify.dev/docs/api/shopify-cli
- AI Toolkit: https://shopify.dev/docs/apps/build/ai-toolkit

### Extensiones (Opcional)
- Checkout UI Extensions: https://shopify.dev/docs/api/checkout-ui-extensions
- Customer Account UI Extensions: https://shopify.dev/docs/api/customer-account-ui-extensions

---

## ⛔ REGLAS CRÍTICAS — NUNCA VIOLAR

### REGLA #1: NUNCA USAR `--force-reset` EN PRODUCCIÓN
- `npx prisma db push --force-reset` ELIMINA TODAS LAS TABLAS Y DATOS
- Si 1000 merchants usaran la app, les borro TODA su configuración
- **EN LA BD DE PRODUCCIÓN**: solo usar `npx prisma db push` (sin --force-reset)
- Si hay conflicto de schema, usar migraciones: `npx prisma migrate dev --name nombre`
- Para producción: `npx prisma migrate deploy` (aplica migraciones pendientes sin tocar datos)
- **VERIFICAR SIEMPRE** el entorno antes de ejecutar comandos destructivos
- Este error ya ocurrió y borró toda la BD de producción (ImportConfig, ProductMapping, ImportLog, BulkJob, ShopSettings, DuplicateLog, PriceRule, ColumnMapping, CategoryMapping)

### REGLA #2: NUNCA EJECUTAR COMANDOS DESTRUCTIVOS SIN CONFIRMACIÓN
- `--force-reset`, `DROP TABLE`, `TRUNCATE`, `DELETE FROM` sin WHERE → SIEMPRE pedir confirmación explícita del usuario
- Primero mostrar qué se va a borrar, luego esperar confirmación

---

## Goal
App embebida Shopify (React Router v7 + Polaris) que importa productos desde archivos CSV/Excel de múltiples proveedores, con reglas de precio, mapeo categoría→colección, mapeo de columnas, preview, detección de duplicados y dos modos de importación: sincrónico por chunks y asíncrono por webhook (bulk operations).

## Constraints & Preferencias
- App embebida en admin Shopify (React Router v7 + Polaris, sin CSS custom)
- CSV: `https://api.mediamax.es/feeds/magento_b2b_b3778c166-7209-11ec-90d6-0242ac120003.csv` (pipe-delimited, quoted)
- Cabecera CSV: `SKU|"ean"|"name"|"short_description"|"description"|"category"|"tipo_producto"|"quantity"|"precio_mediamax_b"|"link"|"image1".."image5"|"is_in_stock"|"weight"|"brand"|"estado_producto"|"outlet"`
- Precio SIN IVA (el usuario incluye IVA en las fórmulas); productos simples; existe la ubicación MDM
- Ausentes del CSV → stock 0 en ubicación MDM; nunca borrar ni cambiar status; CREATE aplica `productStatus` (DRAFT default), UPDATE conserva status; `inventoryPolicy: "DENY"`
- SQLite vía Prisma; frecuencia configurable + modo importación (chunks 50 / bulk)
- 3 reintentos por producto y luego skip con error logueado; preview antes de importar; notificaciones (email + webhook)
- Fórmulas de precio: `C`, `*+−/()`, coma como decimal; redondeo (.95/.99/custom); compare-at; prioridad producto > categoría > general
- EAN→barcode, `brand`→vendor, `short_description`→SEO description, `description`→descriptionHtml, `tipo_producto`→`custom:tipo_producto`, `estado_producto`→`custom:google_condition`, `precio_mediamax_b`→`custom:costo`
- Mapeo de columnas y categoría→colección configurables vía UI (dropdowns)
- **updateOptions (multi-select)**: el usuario elige qué campos actualizar en productos existentes (name, description, price, stock, images, vendor, productType, tags, metafields, collections); los no seleccionados se conservan en UPDATE
- **Exclusiones**: el usuario define reglas para omitir productos (por palabras en título, SKU con wildcards, EAN) y reglas por-SKU/EAN para omitir campos específicos (precio, stock, ambos) en updates

## Stack y arquitectura
- React Router v7 (`@react-router/dev` + `@react-router/serve`), `vite`, `vite-tsconfig-paths`
- `app/shopify.server.ts`: `shopifyApp()` con PrismaSessionStorage, `AppDistribution.AppStore`, `ApiVersion.July26`, webhooks APP_UNINSTALLED + BULK_OPERATIONS_FINISH (http `/webhooks`), `afterAuth` registra webhooks
- Rutas protegidas con `authenticate.admin(request)`; `data()` en vez de `json()` (RRv7)
- PostgreSQL en Railway (via Prisma + PgBouncer)
- Scheduler `node-cron` en `app/lib/scheduler.server.ts` (intervalo 60s para reconcile)

## Progreso
### Hecho
- Migración Remix v2 → React Router v7
- Pipeline bulk completo con resume/recovery
- updateOptions, exclusiones, metafield definitions
- **Multi-proveedor**: ImportConfig N:1 por shop, CRUD proveedores, dashboard principal
- **Detección de duplicados**: 3 políticas (create_both, priority, skip_existing), DuplicateLog, badges
- **Soporte Excel**: librería xlsx, detección automática de formato
- **Upload archivos**: upload local (CSV/Excel), DropZone en config, soporte file paths en engines
- **Configuración general**: política duplicados, prioridad proveedores
- Prisma schema con ShopSettings, DuplicateLog, ImportConfig (name, shopDomain no unique)
- **Lookup debe completar fully** (removed 30% threshold) — import aborta si cualquier batch falla
- **Fix finalizing hang**: finalizeBulkImport ahora maneja manifest faltante, log not found, log.status !== running
- **Reconcile fix**: detecta targeted lookup completado (shopifyOpId=null, status=processed) y re-ejecuta prepareAndLaunch
- **Fix bucle URL sin `shop`** (commits `4bf7d70`,`7413ab0` + universal link): loader `/app` detecta petición sin `shop` → top-level hace 302 server-side a Shopify (mismo `pathname` dinámico, sin JS → no puede bucear); `AppBridgeBounce` sin `document.referrer`; interceptor: 401+HTML deja renovar nativo, 502 siempre, catch solo `TypeError` de dominio propio; catch-all preserva `location.search`
- **Fix rebote a dashboard por inactividad** (commit `3544126`): `safeAuthenticate` hace `redirect("/")` al caducar token → desmonta/remonta layout `App` (única ruta raíz fuera de `/app`) → dashboard. `app.tsx` guarda última ruta en `sessionStorage` (`ip_last_route`, params volátiles strip) y la restaura SOLO si `App` remonta dentro del mismo documento (rebote) en `/app`; cargas de documento nuevo (F5, NavMenu `<a>`, apertura desde admin) resetean flag `docLoaded` → nunca restauran; cooldown 30s anti-bucle; sin tocar tokens/auth
- **Proveedores reconfigurados tras wipe de BD** (verificado en BD prod 2026-09-27): las 5 configs presentes con 16 columnMaps cada una, price rules (Mediamax 1, Aseuropa 2, "3" 1, Inpex 1, Mayor2010 0), category maps (1/2/1/3/0), `excludeFieldRules`, ShopSettings en las 2 tiendas, imports `completed` recientes. Configs con `isActive=false` y Mayor2010 sin price/category maps → **intencional del usuario**
- **Checkpoint/resume implementado** (ambos modos): bulk — `bulk-import.server.ts:1214-1257` guarda `resumeFromLine` cada 500 filas, `:1222` salta líneas ya procesadas, `:1577` limpia al terminar streaming; chunks — `queue-manager.server.ts:218-244` (extrae `lastSku` del ImportLog huérfano) → `import-engine.server.ts:671-682` (`resumeFromSku`)
- **Fix app en blanco por pestaña stale** (commit `4b676aa`): pestaña con build viejo → `/__manifest` version mismatch → 204 + `X-Remix-Reload-Document` → `window.location.href` recarga documento con URL sin `shop` → `validateShopAndHostParams` → App Bridge HTML status 200 → `AppBridgeBounce` no hacía nada → blanco. Fix: `app.tsx` guarda ctx (`ip_ctx`: shop/host/embedded/locale) en sessionStorage mientras la URL lo trae; `AppBridgeBounce` sin shop en iframe navega la ventana top al admin (`buildAdminAppUrl`, ruta actual) con cooldown 15s + fallback universal; sin tocar tokens/auth
- **Fix reglas por-SKU/EAN + progreso vivo cola bulk** (commit `537911a`, deploy OK): `getExcludedFields(sku, rules, ean?)` acepta EAN como clave alternativa (regla guardada con `6932554425630` coincidía solo si la fila se buscaba por SKU → precio se enviaba igual) en bulk `:1428`, chunks `:752,:779` y preview `:462`; pase final de stock bulk (`finalizeBulkImport`) ahora respeta `meta.skipStock`/`stockApplied` Y reconsulta `excludeFieldRules` vivas por SKU/EAN antes de `inventorySetQuantities` (los `skipStock/stockApplied` solo se seteaban al preparar → la regla añadida durante el prepare no se aplicaba); `BulkJobOp` +4 columnas aditivas (`progressCount`, `progressTotal`, `shopifyStatus`, `shopifyObjectCount`): progreso del post-proceso cada 25 productos, status/objectCount de la op rellenados por reconcile desde `getBulkOperation`; cola `app.queue.tsx` texto unificado `Op X/Y · N/M productos [· Post-proceso X/Y | · Shopify: STATUS (n)]` + estimado con fracción de op en curso; UI config etiquetas "SKU o EAN" (6 idiomas). NOTA: primera run tras el fix (job `cmujyjwhq` finalizó a las 16:27 UTC con build viejo) SÍ escribió precio+stock del producto de prueba `XIAREDNOT174G6256BL`; la regla omite desde la siguiente run
- **Fix contadores bulk 447/478 → 924/1 (doble pasada post-proceso)**: causa raíz = post-proceso de la op create (924 filas, ~58 min a 3.75s/fila) > `STALE_PROCESSING_MS=30min` → `resetStaleProcessing` reseteaba la op aunque la pasada seguía viva → 2ª pasada reclamaba y reclasificaba con `actuallyNew = op.kind==="create" && !existingMapping` (veía los mappings creados por la 1ª pasada → 477 "updates" falsos; solo la 2ª pasada escribió contadores, `mutationOpsDone=2`; evidencia: histograma `lastSyncAt` uniforme 15:17:05→16:15:31, corte exacto a 30 min). Fixes: (1) **checkpoint por fila** `${kind}-processed-${op.id}.jsonl` (append al final del try de cada fila, nombre por `op.id` → un re-prepare con ops nuevas no reutiliza checkpoints viejos); en re-entrada (reset/crash) salta filas completadas, restaura contadores con sus flags reales y re-encola imageQueue/skuOverwrite idempotentes; (2) **heartbeat stale**: `BulkJobOp.progressUpdatedAt` — claim + progressCount c/25 filas + beats en post-loop (sku overwrite antes/después y c/10 items, batch de imágenes vía `onBatch`, intentos de transient retry) — solo beattea la pasada poseedora → `resetStaleProcessing` resetea a los **10 min sin latir** (`STALE_PROGRESS_MS`), fallback `startedAt>30min` solo si heartbeat null (ops lookup/legacy); (3) **`claimToken` single-writer**: claim genera token; todos los writes de la pasada pasan por `beatOp` (updateMany where `{id, claimToken}`) incl. el final `beatOp({status:"processed"})` → `count===0` (pasada superada) → return sin escribir contadores de BulkJob ni ImportLog. **Contadores históricos corregidos en BD**: ImportLog `cmujyjwh60006n10pd58ovc3b` + BulkJob `cmujyjwhq0008n10pamv6rljv` → created/createCount=924, updated/updateCount=1 (924 creados + 1 actualizado = producto manual, verificado por usuario)

- **Fix run 921/2 (2 updates "fantasma") + paquete anti-zombi/contadores en vivo/perf** (2026-09-28): causa raíz del "2º update" = **falso stale** (NO deploy: solo hubo deploy `4237a70` @18:51Z; pass1 reclamó 20:38:56, último beat 21:22:16; filas se lentificaron ~21:12 de ~6s a ~26s por latencia de `publishablePublish` → beat c/25 filas ≈10.4min > umbral 10min → stale a 21:32:16, 24s antes del siguiente beat) → pass2 reclamó 21:32:29 y clasificó como "update" el producto `SAMGALS26ULT5G161TBWH` (su checkpoint se appendeó ~21:32:38 tras el load de mappings/mappings de pass2; vecinos TBPK/TBBK cuadran) → **contadores reales 922/1** (solo el manual), producto bien en Shopify (cosmético). Pass1 siguió viva como **zombi** (flips `pending→complete` hasta 00:10-00:12 UTC, gated por claimToken → no corrompió contadores). Fixes implementados: (1) **heartbeat por tiempo**: beats c/25 filas **o** c/45s (`lastBeatAt`/`rowsSinceBeat`) → filas lentas ya no pueden superar `STALE_PROGRESS_MS=10min`; (2) **anti-zombi**: `beatLive()` (escritura única con trío de contadores + heartbeat, gated por claimToken) devuelve `count===0` → `claimLost` → la pasada abandona en el loop y en cada sección del post-loop (sku overwrite, imágenes, transient retries) SIN escribir contadores (el gate final `finish` ahora también trata `null` como perdido); (3) **contadores en vivo**: `BulkJobOp +liveCreatedCount/liveUpdatedCount/liveUnchangedCount` (nullable, `db push` aditivo ya aplicado a prod); claim los resetea a 0; `beatLive` los escribe c/25 filas o 45s; `queue-manager.server.ts` los pliega en Loop2 + `activeWithProgress` (suma de ops `processing`); flag `createdPending` (mutationOpsDone=0 && suma=0) → `app.queue.tsx` muestra `Creados: —` en vez de `0` (sin claves nuevas i18n); (4) **perf media**: `setTimeout(3000)` fijo → `pollProductMediaForImages()` polling backoff 400ms→5s cap 17s (actualizados ~400ms, creados en cuanto aparece; si no aparece → `[]` = misma semántica que antes); (5) **perf filas**: loop secuencial → worker pool `BULK_ROW_CONCURRENCY` (default 4, clamp 1-8); seguro porque contadores son incrementos síncronos (event loop), GraphQL pasa por token-bucket global `rateLimitedGraphql`, checkpoints serializados en `checkpointChain` (drenada antes del gate), `existingMappingsMap` es solo-lectura (clasificación idéntica a secuencial); (6) **BD corregida**: ImportLog `cmuka1grl0002pi0pk3t5m2f9` + BulkJob `cmuka1hae0004pi0pa609a3re` 921/2 → **922/1** (guards `created:921 AND updated:2`, ambos match 1)

- **Migración a Shopify App Pricing** (commit `02f180d`, deploy SUCCESS 2026-09-28): Partner API como fuente de verdad de suscripciones, gate a planes alojados de Shopify, retorno `plan_handle` verificado antes de auth, botones de plan → página alojada, cancel vía `appSubscriptionCancel`; sin cambios en imports/bulk/cola ni en `DEVELOPER_STORES`
- **Endpoint crudo bulk a API 2026-07** (commit `dd23194`, deploy SUCCESS 2026-09-28): `getFreshAdminClient` (`bulk-import.server.ts:70`) usaba `admin/api/2026-01/graphql.json` mientras el resto de la app corre en `ApiVersion.July26`; avisos del Partner Dashboard de mutaciones `InventoryQuantityInput.changeFromQuantity` pueden provenir de esa desalineación de versión (2026-01 no soporta `changeFromQuantity` con significado esperado → contexto del fix a revisar). Único call site de versión fija en `app/`
- **Gate a planes casi instantáneo (commit `28d358f`, deploy SUCCESS 2026-09-28)**: (1) `requireSubscription` se lanza EN PARALELO con `safeAuthenticate` usando el `shop` de la URL (`looksLikeRealDoc`: embedded/id_token/session_token + regex dominio myshopify; si auth falla o no cuadra el id_token, el resultado especulativo se descarta y hay fallback secuencial con timeout 8s); (2) documento embedded sin plan → `throw new Response` con **bounce inline mínimo** (`<script data-plans-gate>window.top.location.replace(plansUrl)</script>` + fallback `window.open(_top)`) que navega la ventana top en el PRIMER parse **sin cargar el script de App Bridge (cdn.shopify.com)** — antes el iframe bloqueaba en el CDN y parecía un refresco lento; `location.replace` no crea entrada de historial → Back no re-dispara el gate; (3) `ErrorBoundary.isAppBridgeHtml` acepta el marker `data-plans-gate` además de `app-bridge`, y el guard de `AppBridgeBounce` cubre ambos (`script[data-api-key], script[data-plans-gate]`); rutas no-embedded/data siguen usando `appRedirect(plansUrl,{target:"_top"})` sin cambios (401-reauth/302 intactos). NOTA: los botones "Probar con este plan" de la captura son de la página alojada de Shopify (no editables); los nuestros ya dicen "Selecciona {{planName}}" (6 idiomas)

### Pendiente
- Prueba con credenciales reales (túnel HTTPS, OAuth, webhooks)
- **E2E de billing App Pricing en tienda dev** (tras configurar Redirect URL ×9 y checkbox ×8 en Partner Dashboard): instalar → gate → planes alojados → aprobar → retorno `plan_handle` verificado → dashboard con límite; verificar en logs `[Billing] Retorno verificado` y ausencia de `Error while billing the store`

## Decisiones clave

### Shopify App Pricing (migración desde Billing API — commit `02f180d`)
- **Causa raíz del rechazo de revisión**: listing con "Shopify App Pricing" seleccionado (8 planes públicos + 1 privado `shopify-test`) pero código usando Billing API → `appSubscriptionCreate` bloqueado → `Error while billing the store` ×6. Al optar por App Pricing la Billing API queda bloqueada ("Once you opt in… you can't create new recurring application charges using the Billing API")
- **Partner API = fuente de verdad** (`app/lib/partner-api.server.ts`): org `4425275`, endpoint `https://partners.shopify.com/4425275/api/2026-07/graphql.json`, header `X-Shopify-Access-Token`; env vars `SHOPIFY_PARTNER_ORG_ID` + `SHOPIFY_PARTNER_API_ACCESS_TOKEN` (Railway + `.env` local, **nunca al repo**); permisos del client: View financials + Manage apps (verificado en vivo: endpoint/token OK, `gid://shopify/App/{numeric}` aceptado)
- **App GID en runtime**: `currentAppInstallation { app { id } }` vía Admin API (cacheado en módulo) — `app(id:)` de Partner API rechaza prefijo `shopify`/devuelve null; no hace falta env var `SHOPIFY_APP_GID`
- **`fetchActiveSubscription(shop, {force?})`**: caché 5 min (contrato) / 15 s (null y errores); `ok:false` = API caída/env/red → el llamante usa fallback; `ok:true + sub:null` = verificado sin contrato. `getSubscriptionInfo`: dev-stores (`DEVELOPER_STORES`) bypass intacto; resto → Partner API → **espeja fila local** (status/trial/billingType/legacySubscriptionId) → si sub null y fila activa con `updatedAt` reciente (<3 min gracia de propagación) NO cancela; si API cae → fila local (**nunca bloquear a un pagando**)
- **Gate sin plan** (`app.tsx` loader, tras `requireSubscription`): `!hasPlan && !pathname.endsWith(".data")` → `throw appRedirect(buildPlansUrl(shop), { target: "_top" })` (helper `redirect` de `authenticate.admin`: embedded doc → App Bridge `window.open(url,"_top")`, doc top-level → 302; `.data` sigue su curso); `catch` re-lanza `Response` antes de los defaults. URL: `admin.shopify.com/store/{tienda}/charges/import-pilot-official/pricing_plans` (`buildPlansUrl` en `admin-link.ts`)
- **Retorno del welcome link** (`/app/billing?plan_handle=…&shop=…`, llega SIN `host`): en `app.tsx` bloque `plan_handle` presente → early-return de datos benignos ANTES de `safeAuthenticate` (que lo mataría en `validateShopAndHostParams`); en `app.billing.tsx` loader, ANTES de auth → `confirmSubscriptionReturn`: exige sesión offline para la tienda, verifica contrato con Partner API (`force`, 2 reintentos ×1.5 s por propagación) → OK espeja+`enforcePlanLimits`; API OK sin contrato → rechaza (`error=verification_failed`); API caída → **confía en el parámetro** (app aún no pública devolvería error de GraphQL; no dejar el flujo muerto) → redirect `/app/billing?plan_handle=` — **el `plan_handle=` vacío es anti-bucle**: el helper de redirect copia los query params actuales al destino cuando es mismo origen y re-añadiría `plan_handle` → loop de verificación
- **UI billing**: botones de plan/switch → `Button url={hostedPlansUrl} target="_top"` (página alojada de Shopify; sin `billing.request`); `billing.check`/`charge_id`/cálculo de trial local eliminados (trial lo gestiona Shopify: `trialEndsAt` desde Partner API); cancel → `appSubscriptionCancel` (Partner API, `deferCancellation:true` sin prorrateo); `BILLING_PLANS` en shopify.server queda sin llamadas (sin tocar)
- **`shopify-test`** (plan privado $0/mes) añadido a `PLAN_LIMITS` con límite 5 → la tienda propia del partner puede autorizarse en ese plan privado (la checkbox "Free for partners and developers" solo aplica a tiendas dev; producción siempre paga precio de plan — para la tienda propia usar el plan privado)
- **HMAC log** (`webhooks.tsx`): detalle real `HTTP {status}` para Responses + topic/shop; verificación y handlers intactos (imports/bulk no se tocan)

### Recuperación de URL sin `shop` (deep-link a admin)
- Cadena en `buildAdminAppUrl(shop, path)`: cookie `ip_last_shop` → `admin.shopify.com/store/{tienda}/apps/{handle}{path}`; sin shop → **link universal** `admin.shopify.com/apps/{handle}{path}` (admin resuelve tienda activa; verificado en navegador). Jamás `admin.shopify.com` a secas
- **Cookies particionadas**: `ip_last_shop` se setea en el iframe (contexto cross-site) → navegadores la particionan (3rd-party) → NO se envía top-level casi nunca → el universal es el fallback NORMAL, no la excepción; la cookie queda como mejora progresiva
- Log `[App Loader] URL sin shop ... (fuente: cookie|db-unico|universal)` para diagnóstico
- Patrón verificado: `admin.shopify.com/apps/{handle}{ruta-app}` abre la app en esa ruta (mismo patrón store-agnostic documentado para POS); con prefijo `/app` incluido (la ruta es la del iframe, no relativa a application_url)

### Modo bulk (async por webhook)
- Orquestación: job persistido en `BulkJob`/`BulkJobOp`; fallback polling `reconcileStaleBulkJobs()` cada 60s
- Inventario en bulk: **pase final separado** con `inventorySetQuantities` en lotes de 100 (`@idempotent`); `inventoryAdjustQuantityAtLocation` para SKUs ausentes del CSV (try/catch, sin abortar)
- Detección de productos existentes: EAN/barcode → SKU → fallback ProductMapping; skip si price+stock sin cambios
- Mutaciones bulk lanzadas con `bulkOperationRunMutation` + `stagedUploadsCreate(resource: BULK_MUTATION_VARIABLES, mimeType: "text/jsonl", httpMethod: POST)` + upload multipart a URL firmada; JSONL chunks ≤80MB
- Bulk requiere **offline token** → `shopify.unauthenticated.admin()` para runs manuales y programados
- **Imágenes**: `ProductInput` NO tiene campo `files` (verificado en docs) → en bulk update no se envían; las imágenes solo se actualizan en modo Chunks (`productUpdateMedia`)

### Lookup debe completar completamente (Option 3)
- `queryProductsTargeted` lanza queries por batches de 15 SKUs/EANs
- Cada batch tiene 3 reintentos con backoff
- Si algún batch falla las 3 veces → THROW → import se aborta
- `reconcileStaleBulkJobs` reintenta el job en el próximo ciclo (cada 60s)
- Cuando el auth esté estable → lookup completo → import seguro, 0 duplicados

### Checkpoint/resume (implementado)
- `BulkJob.resumeFromLine` (Int?) en schema
- **Bulk**: checkpoint cada 500 filas durante streaming en `prepareAndLaunch` (`bulk-import.server.ts:1214-1257`), skip de líneas procesadas (`:1222`), se limpia al completar el streaming (`:1577`)
- **Chunks**: `ImportLog.lastSku` como checkpoint → `queue-manager.server.ts:218-244` lo extrae del log huérfano y relanza con `resumeFromSku` → `import-engine.server.ts:671-682` salta hasta ese SKU

### Resume / recovery de jobs bulk
- Estados `BulkJob.phase`: lookup → mutations → finalizing → done/failed
- Estados `BulkJobOp.status`: pending → launched → processing → processed/failed
- `prepareAndLaunch` persiste manifest + `phase="mutations"` ANTES de lanzar ops
- `reconcileStaleBulkJobs` (60s): relanza lookup si falta; relanza ops pending/missing; procesa ops completed no procesadas; completa finalize si todas procesadas; reanuda jobs en finalizing
- Claims atómicos `launched→processing→processed` evitan doble procesado
- **Reconcile fix**: si lookup op tiene `status=processed` pero `shopifyOpId=null` (targeted approach completó pero prepareAndLaunch falló), re-ejecuta queryProductsTargeted + prepareAndLaunch completo
- **Anti-duplicados**: lock de 1 job activo por tienda; `listRecentMutationOps` detecta ops fantasma; `lookupSkusSync` verifica existencia real

### Limpieza de jobs terminados
- `cleanupFinishedBulkJobs()` (60s con el reconcile) borra BulkJobOps + BulkJob + directorio de trabajo de jobs `done/failed` más antiguos que `MEDIMAX_JOB_RETENTION_DAYS` (default 7)

### Modo chunks (sincrónico)
- `runImport` (`app/lib/import-engine.server.ts`): stream CSV → lotes `config.chunkSize`; create vía `productSet(synchronous:true)`; update vía `productUpdate` + `productVariantsBulkUpdate` + `inventorySetQuantities` (stock) + `productUpdateMedia` (imágenes)
- updateOptions aplica también aquí (filtrado de campos y detección de cambios)

### updateOptions (campos)
- `name, description, price, stock, images, vendor, productType, tags, metafields, collections`
- Guardado como JSON string en `ImportConfig.updateOptions` (default: todos)

### Exclusiones
- **Exclusión de productos**: `isExcluded(row, columnMaps, config, getFieldFn)` evalúa 3 reglas: título (case-insensitive), SKU (wildcards), EAN (wildcards)
- **Exclusión de campos por-SKU/EAN**: `parseExcludeFieldRules(raw)` + `getExcludedFields(sku, rules, ean?)` — JSON array de `{ sku, skip: ["price"|"stock"|"price","stock"] }` (clave = SKU o EAN)
- Configurados en UI: 3 TextField (título, SKU, EAN) + tabla de reglas por-SKU/EAN
- **Conteo**: `excludedCount` en `ImportLog` y `BulkJob`

## Esquema Prisma (notas)
- `ImportConfig.updateOptions String` (JSON array)
- `ImportConfig`: + `excludeTitleWords`, `excludeSkus`, `excludeEans` (String?), `excludeFieldRules` (String? JSON)
- `ImportConfig`: + `name` (String, nombre proveedor), shopDomain ya NO es unique (N:1 por shop)
- `ShopSettings`: `shopDomain` unique, `duplicatePolicy`, `supplierPriority`, `maxSuppliers`, `matchMode`
- `DuplicateLog`: tracking de duplicados entre proveedores
- `ProductMapping`: + `ean`, `shopifyVariantId`, `shopifyInventoryItemId`
- `ImportLog` + `BulkJob`: + `excludedCount`, `costChanges`
- `BulkJob`: + `resumeFromLine` (Int?) para checkpoint/resume
- `BulkJobOp`: `shopifyOpId` nullable, `status`, `startedAt`, + `progressCount`/`progressTotal` (progreso vivo post-proceso), + `shopifyStatus`/`shopifyObjectCount` (reconcile), + `progressUpdatedAt` (heartbeat, stale a 10 min), `claimToken` (single-writer gated)
- `BulkJob.phase`: lookup | mutations | finalizing | done | failed
- 3 composite indices: `BulkJobOp(jobId, status)`, `BulkJob(configId, phase)`, `ImportLog(configId, status)`

## Archivos relevantes
- `app/routes/_index.tsx`: Dashboard principal
- `app/routes/app._index.tsx`: Dashboard dentro del layout /app
- `app/routes/app.tsx`: Layout con NavMenu
- `app/routes/app.supplier.$id.tsx`: Detalle proveedor con tabs
- `app/routes/app.supplier.$id.config.tsx`: Configuración del proveedor
- `app/routes/app.supplier.$id.columns.tsx`: Mapeo de columnas
- `app/routes/app.supplier.$id.price-rules.tsx`: Reglas de precio
- `app/routes/app.supplier.$id.category-mapping.tsx`: Mapeo categorías
- `app/routes/app.supplier.$id.preview.tsx`: Preview
- `app/routes/app.supplier.$id.logs.tsx`: Historial
- `app/routes/app.settings.tsx`: Configuración general
- `app/routes/app.duplicates.tsx`: Duplicados detectados
- `app/routes/api.upload.tsx`: Upload de archivos
- `app/lib/bulk-import.server.ts`: pipeline bulk + resume + duplicate detection + lookup fix
- `app/lib/import-engine.server.ts`: motor chunks + duplicate detection
- `app/lib/duplicate-detection.server.ts`: checkDuplicate(), logDuplicate()
- `app/lib/csv-parser.server.ts`: streamCSV, streamExcel, streamFile, fetchCSVHeaders, isExcluded
- `app/lib/db.server.ts`: prisma, getOrCreateConfig, getConfigById
- `app/lib/scheduler.server.ts`: reconcile 60s + cleanup
- `app/lib/queue-manager.server.ts`: enqueue(), processNext()
- `app/lib/location.server.ts`: getLocationId
- `prisma/schema.prisma`: schema completo

## Siguientes pasos
- **Dashboard Partner** (usuario): campo "Redirect URL" de CADA plan (8 públicos + `shopify-test`) = `https://import-pilot-production.up.railway.app/app/billing`; checkbox "Free for partners and developers" en los 8 públicos
- E2E billing en tienda dev (ver Pendiente); tunnel HTTPS + credenciales para OAuth/webhooks si se retoma
