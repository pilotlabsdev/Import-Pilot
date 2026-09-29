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
- **Fix Partner API "sin GIDs" (commit `f0f1a11`, deploy SUCCESS 2026-09-29)**: `admin.graphql()` de `@shopify/shopify-app-react-router` devuelve `new Response(JSON.stringify(body))` (ver `clients/admin/graphql.js`), NO el body — `getShopGid`/`getAppGid` leían `res?.data?.shop?.id` → `undefined` silencioso → `resolveGids` null → **toda la Partner API (gate, retorno, espejo, cancelación) caía siempre a fila local desde el día 1**. Fix: `await res.json()` + log de `errors` GraphQL (patrón del resto del código: `location.server.ts`, `scheduler.server.ts`). Verificado: script directo con token offline de price-pilot → shop `gid://shopify/Shop/99229040978`, app `gid://shopify/App/412280553473`, Partner API `activeSubscription` → `basic-monthly`, trial hasta 2026-10-12, EVERY_30_DAYS; logs post-deploy sin `sin GIDs`. **E2E billing en price-pilot**: gate → planes alojados → "Aprobar cargo" (plan gratis/trial, email de confirmación de Shopify es normal) → retorno `plan_handle` (aquí cayó en "confiando en plan_handle" por el bug ya corregido) → `/app/billing` muestra "Tu plan actual Basic"; nav `Planes (basic-monthly)`. Scripts diagnóstico `scripts/_check-gids.cjs` y `_check-partner.cjs` (no commitear)

- **E2E billing App Pricing COMPLETADO en price-pilot** (2026-09-29): gate → planes alojados → aprobar → retorno verificado → cambio de plan desde la app (`/app/billing` → página alojada → aprobar) → **`[Billing] Retorno verificado vía Partner API: growth-monthly (trial=true)`** + `GET /app/billing?plan_handle=growth-monthly&charge_id=83344425298 302` → `?plan_handle= 200` (anti-bucle OK); cero `Error while billing the store`, cero `sin GIDs`, cero `confiando en plan_handle` (el approve inicial fue pre-fix y usó la vía de confianza; el switch post-fix verificó de verdad); `enforcePlanLimits` sin cambios (2 slots ≥ 2 suppliers); emails de confirmación de Shopify en ambos cambios (normales, plan gratis/trial)
- **Perf app + fix errores de revisión (2026-09-29)**: (1) lentitud 7.3s/dashboard resuelta reiniciando contenedor (estado degradado tras 5 deploys seguidos); logs `[Timing]` en loaders `app.tsx`/`app._index`/`enforcePlanLimits`/partner miss — tras fix: dashboard 61-84ms, layout 37-58ms; (2) `favicon.ico` 404 → `routes.ts` es config explícita y no lo registraba (única huérfana) → `route("favicon.ico", ...)` añadida; (3) **APP_UNINSTALLED en bucle de 500**: `expiringOfflineAccessTokens:true` + token revocado por uninstall → `ensureValidOfflineSession` de la librería lanza 500 → devolvíamos 401 → Shopify reintentaba y la limpieza NUNCA corría → ahora path manual (`verifyHmac` a mano + cleanup shopSettings/session/cola SIN sesión + 200); (4) fuzz de shop (`https://÷ßuÓ…`) → la librería renderizaba HTML App Bridge (shop inválido) o lanzaba TypeError en `sanitizeHost` → RR respondía 500; `safeAuthenticate` ahora pre-valida shop+host con los helpers OFICIALES `shopifyCore.utils.sanitizeShop/sanitizeHost` (commit `f1e53de`, deploy SUCCESS 2026-09-29; instancia propia `shopifyApi()` porque `shopifyApp()` no expone `.utils` ni `.api` — OJO: `import { sanitizeShop } from "@shopify/shopify-api"` NO existe, es `shopifyApi().utils.*`) → 400 limpio (verificado: shop fuzz → 400, host fuzz → 400, tráfico real → 200); (5) `getShopGid sin sesión` (probes cross-shop de revisión) → pre-check `prisma.session` + log info sin excepción. NOTA: deploy reinicia contenedor; docs+code en UN commit para no duplicar restarts
- **Veredicto billing "Partner API no disponible (GraphQL: Unexpected system error)" (2026-09-29)**: error TRANSITORIO del backend de Shopify Partners (no de key/permisos — eso daría 401); no requiere código. Doc oficial `shopify-app-pricing` explícita: *"Query `activeSubscription` in the Partner API"* y *"With Shopify App Pricing, you use the Partner API... This is different from the Billing API, where subscription status comes from the GraphQL Admin API"* → NUESTRO enfoque es el canónico; el sugerido por asistentes AI (`currentAppInstallation.activeSubscriptions` vía Admin API) es el método LEGACY y devuelve array vacío con planes App Pricing (contratos creados por Shopify, no por la app) → NO cambiar. Fallback fila local funcionó (nadie bloqueado); logs posteriores `ok=true` en cada ciclo de ~6 min
- **Fix página de columnas: navegación sin bloquear + fusible de conexión (2026-09-30)**: loader de `app.supplier.$id.columns.tsx` ya no descarga el CSV para crear mappings por defecto (bloqueaba la navegación: primera carga 36-58s con el feed de api.mediamax.es lento; el resto de llamadas ya eran ~20-55ms) → defaults vía `intent=bootstrap` en la action DESPUÉS de que el cliente carga cabeceras (reutiliza `getCachedHeaders` cacheado → instantáneo) + hidratación única de los selects cuando los mappings llegan por revalidación; `streamCSV`/`streamExcel` con **timeout TTFB 120s** (`fetchWithTtfbTimeout`: timer cancelado en cuanto `fetch()` resuelve → solo capa la fase de conexión/primeiros bytes, NO el streaming del cuerpo → imports bulk/chunks intactos). **OJO medido 2026-09-30**: el feed de api.mediamax.es genera el fichero antes de responder → **TTFB real ≈ 35s** (sonda directa: primer byte 35.093ms) — un fusible de 30s (valor inicial) daba falso negativo y abortaría imports que sí funcionan; por eso 120s. Un timeout NO se reintenta (rethrowIfTimeout rompe el loop de reintentos: si no responde en 120s, 2 reintentos más solo alargarían el fallo — el usuario/job re-lanza). AbortError → "El servidor del feed no respondió tras 120s" en el banner; **dedup in-flight** en `csv-cache.server.ts` (`dedupe()` — clics/peticiones concurrentes de la misma clave comparten un único stream, error limpia la promesa para no envenenar); **botón Reintentar** en el banner de error de cabeceras (`columns.retry`, i18n ×6: es Reintentar/en Retry/pt Tentar novamente/de Erneut versuchen/fr Réessayer/it Riprova)
- **Perf navegación /app: 5s → ~1s (2026-09-30)**: desglose `[Timing] app-layout` = auth≈0.8s + gate≈2s + counts≈2s en TODAS las rutas /app (no era de columnas — el loader de columns sumaba ~1ms tras quitar el CSV). Causas y fixes: (1) **doble `getSubscriptionInfo` por navegación** (gate vía `requireSubscription` + counts) ≈6 queries BD extra → ahora **UNA** llamada reutilizada para `hasPlan`+`planLabel`+`counts` (speculativa en paralelo con auth como antes; dev bypass en gate sin llamada, planLabel "Dev" no la necesita; se eliminó `requireSubscription` del loader — solo lo usaba app.tsx); (2) **`upsertSubscription` escribía en CADA llamada** (findUnique+upsert = 2 queries + escritura inflando `updatedAt`) → si no cambió nada devuelve `existing` (2 queries → 1, cero escrituras; la gracia `MIRROR_CANCEL_GRACE_MS` ahora se mide desde el último cambio REAL — más correcto); (3) **counts**: 3 queries secuenciales (importQueue/importLog/bulkJob) → paralelas + **caché 25s por tienda** (`navCountsCache`, TTL > auto-revalidate 20s → las ráfagas de 3 pestañas salen de caché; badges ≤25s stale). Medido: **cada query BD ≈907ms constantes** desde máquina local (host Railway = `switchback.proxy.rlwy.net` — proxy público, mismo que usa la app); desde el contenedor varía 5ms↔600ms según ráfaga. ~~PENDIENTE auth≈0.8s fijo por request — sospecha JWKS/token~~ → **RESUELTO**: `[Timing] authenticate.admin` = 11-34ms cuando la BD va rápida y ~700-800ms en ráfagas lentas → auth NO es código, es la misma latencia BD
- **Diagnóstico latencia BD: la app sale por el proxy PÚBLICO de Railway (2026-09-30)**: desglose medido local→mismo proxy: TCP connect 31-40ms, **handshake TLS al proxy 373-649ms** (debería ser ~60-100ms), query en conexión establecida ~907ms → varianza 18ms↔900ms = congestión del proxy/PgBouncer, no código. Env vars del servicio: `DATABASE_URL` = `switchback.proxy.rlwy.net:49308` (**TCP proxy público**, params `pgbouncer=true&connection_limit=40&pool_timeout=60&connect_timeout=10&socket_timeout=30&sslmode=require`) y `DATABASE_UNPOOLED_URL` = **`postgres.railway.internal:5432`** (red privada del proyecto, db=/railway, sin params). Doc Railway: `DATABASE_URL` = "PgBouncer — red privada" y el público es `DATABASE_PUBLIC_URL` → deberíamos usar la red interna. Sonda `[DBDiag]` en `db.server.ts` (una vez por proceso: SELECT 1 ×3 ruta pública + ×3 interna con `datasourceUrl` override, timeout 10s, fire-and-forget) desplegada para decidir el switch; si gana la interna → switch en `db.server.ts` priorizando `DATABASE_UNPOOLED_URL` (revert = git revert, sin tocar vars Railway; `connection_limit=40&pool_timeout=60&connect_timeout=10` añadidos a la URL interna, sin `pgbouncer=true` porque es Postgres directo). NOTA: `railway ssh keys add` NO detecta claves en este Windows (claves generadas en `~/.ssh/id_ed25519*`/`id_rsa`, CLI responde "No SSH keys found"; servicio ssh-agent Disabled y sin admin) → para usar `railway ssh` registrar la clave a mano en https://railway.com/account/ssh-keys
- **Perf billing + limpieza (2026-09-30)**: `upsertSubscription` acepta fila prefetched (séptimo arg opcional): `getSubscriptionInfo` ya tiene la fila del espejo → ahorra 1 query por llamada (gate ≈700ms menos con la latencia actual); sonda `dbprobe` por-request eliminada del loader `app.tsx`

### Pendiente
- **Evaluar `[DBDiag]` post-deploy y decidir switch a red interna** (`postgres.railway.internal`); eliminar la sonda al decidir (junto con el switch o en el siguiente commit)
- Prueba con credenciales reales (túnel HTTPS, OAuth, webhooks)

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
