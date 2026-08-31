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
- **Exclusiones**: el usuario define reglas para omitir productos (por palabras en título, SKU con wildcards, EAN) y reglas por-SKU para omitir campos específicos (precio, stock, ambos) en updates

## Stack y arquitectura
- React Router v7 (`@react-router/dev` + `@react-router/serve`), `vite`, `vite-tsconfig-paths`
- `app/shopify.server.ts`: `shopifyApp()` con PrismaSessionStorage, `AppDistribution.AppStore`, `ApiVersion.July26`, webhooks APP_UNINSTALLED + BULK_OPERATIONS_FINISH (http `/webhooks`), `afterAuth` registra webhooks
- Rutas protegidas con `authenticate.admin(request)`; `data()` en vez de `json()` (RRv7)
- SQLite + Prisma (`prisma/schema.prisma`); comandos: `npm run db:push`, `npm run db:migrate`
- Scheduler `node-cron` en `app/lib/scheduler.server.ts` (intervalo 60s para reconcile)

## Progreso
### Hecho
- Migración Remix v2 → React Router v7
- Pipeline bulk completo con resume/recovery
- updateOptions, exclusiones, metafield definitions
- **Multi-proveedor**: ImportConfig N:1 por shop, CRUD proveedores, dashboard principal
- **Detección de duplicados**: 3 políticas (create_both, priority, skip_existing), DuplicateLog, badges
- **Soporte Excel**: librería xlsx, detección automática de formato
- **Upload archivos**: upload local (CSV/Excel),DropZone en config, soporte file paths en engines
- **Configuración general**: política duplicados, prioridad proveedores
- Prisma schema con ShopSettings, DuplicateLog, ImportConfig (name, shopDomain no unique)

### Pendiente
- Migrar upload a Supabase Storage (archivos persistentes, TTL 24h)
- Prueba con credenciales reales (túnel HTTPS, OAuth, webhooks)

## Decisiones clave

### Modo bulk (async por webhook)
- Orquestación: job persistido en `BulkJob`/`BulkJobOp`; fallback polling `reconcileStaleBulkJobs()` cada 60s
- Inventario en bulk: **pase final separado** con `inventorySetQuantities` en lotes de 100 (`@idempotent`); `inventoryAdjustQuantityAtLocation` para SKUs ausentes del CSV (try/catch, sin abortar)
- Detección de productos existentes: EAN/barcode → SKU → fallback ProductMapping; skip si price+stock sin cambios
- Mutaciones bulk lanzadas con `bulkOperationRunMutation` + `stagedUploadsCreate(resource: BULK_MUTATION_VARIABLES, mimeType: "text/jsonl", httpMethod: POST)` + upload multipart a URL firmada; JSONL chunks ≤80MB
- Bulk requiere **offline token** → `shopify.unauthenticated.admin()` para runs manuales y programados
- **Imágenes**: `ProductInput` NO tiene campo `files` (verificado en docs) → en bulk update no se envían; las imágenes solo se actualizan en modo Chunks (`productUpdateMedia`)

### Resume / recovery de jobs bulk
- Estados `BulkJob.phase`: lookup → mutations → finalizing → done/failed
- Estados `BulkJobOp.status`: pending → launched → processing → processed/failed; `shopifyOpId` nullable (filas pending); `startedAt` para detectar "processing" colgadas (>10 min → reset a launched)
- `prepareAndLaunch` persiste manifest + `phase="mutations"` ANTES de lanzar ops (sin carrera de duplicados)
- `reconcileStaleBulkJobs` (60s): relanza lookup si falta; relanza ops pending/missing; procesa ops completed no procesadas; completa finalize si todas procesadas; reanuda jobs en finalizing
- Claims atómicos `launched→processing→processed` evitan doble procesado (webhook + reconcile); `tryFinalize` con claim de fase; `finalizeBulkImport` idempotente (guarda por estado del log + `lastQuantity` zerado)
- **Anti-duplicados (race window "launch vs guardar opId")**:
  - Lock de 1 job activo por tienda (rechaza segundo job si hay lookup/mutations/finalizing)
  - Antes de relanzar un create pendiente: `listRecentMutationOps` (`bulkOperations` type MUTATION) detecta op fantasma; si CREATED/RUNNING → esperar
  - Si terminada: `lookupSkusSync` (por lotes de 50 SKUs) verifica existencia real; SKUs existentes se ADOPTAN (ProductMapping + inventario), los faltantes se reconstruyen en fichero filtrado y se relanzan
  - Updates pendientes se relanzan directo (productUpdate idempotente)
  - `clientIdentifier` de `bulkOperationRunMutation` NO sirve: `BulkOperation` no lo devuelve (verificado)
- Directorio de trabajo configurable: `MEDIMAX_BULK_DIR` (default `os.tmpdir()/mediamax-bulk`) para persistir JSONL entre reinicios; visible en la UI de Config (Banner cuando importMode=bulk)
- **Limpieza de jobs terminados**: `cleanupFinishedBulkJobs()` (60s con el reconcile) borra BulkJobOps + BulkJob + directorio de trabajo de jobs `done/failed` más antiguos que `MEDIMAX_JOB_RETENTION_DAYS` (default 7)

### Modo chunks (sincrónico)
- `runImport` (`app/lib/import-engine.server.ts`): stream CSV → lotes `config.chunkSize`; create vía `productSet(synchronous:true)`; update vía `productUpdate` + `productVariantsBulkUpdate` + `inventorySetQuantities` (stock) + `productUpdateMedia` (imágenes)
- updateOptions aplica también aquí (filtrado de campos y detección de cambios)

### updateOptions (campos)
- `name, description, price, stock, images, vendor, productType, tags, metafields, collections`
- Guardado como JSON string en `ImportConfig.updateOptions` (default: todos)
- Bulk: trigger de update solo si cambia price (opción price) o stock (opción stock); `mapCsvRowToBulkUpdateInput` envía solo los campos seleccionados; ProductMapping persiste solo lo aplicado (flags `priceApplied`/`stockApplied`)
- Chunks: mismo filtrado + stock vía inventory + imágenes vía media

### Exclusiones
- **Exclusión de productos**: `isExcluded(row, columnMaps, config, getFieldFn)` en `csv-parser.server.ts` evalúa 3 reglas:
  - *Título*: palabras separadas por coma, case-insensitive substring match (ej: `outlet, refurbished`)
  - *SKU*: patrones con wildcard `*` al inicio/fin (ej: `OUT-*`, `*-END`, `TEST-SKU`)
  - *EAN*: igual que SKU, wildcard soportado
- **Exclusión de campos por-SKU**: `parseExcludeFieldRules(raw)` + `getExcludedFields(sku, rules)` — JSON array de `{ sku, skip: ["price"|"stock"|"price","stock"] }`
- Configurados en UI: 3 TextField (título, SKU, EAN) + tabla de reglas por-SKU con add/delete
- **Integración**: 
  - Bulk: se ejecuta en `prepareAndLaunch` después de dedup; `excludeFieldRules` se aplica antes de `mapCsvRowToBulkUpdateInput`
  - Chunks: se ejecuta en streaming loop; `excludeFieldRules` se aplica antes de cada `processProduct`
  - Preview: `isExcluded()` se llama en el loop y se cuenta en `stats.excluded`
- **Conteo**: `excludedCount` en `ImportLog` y `BulkJob`; dashboard muestra columna "Excluidos" + stat card
- **Persistencia**: `excludeTitleWords`, `excludeSkus`, `excludeEans` (String?), `excludeFieldRules` (String? JSON) en `ImportConfig`

## Esquema Prisma (notas)
- `ImportConfig.updateOptions String` (JSON array)
- `ImportConfig`: + `excludeTitleWords`, `excludeSkus`, `excludeEans` (String?), `excludeFieldRules` (String? JSON)
- `ImportConfig`: + `name` (String, nombre proveedor), shopDomain ya NO es unique (N:1 por shop)
- `ShopSettings` (nuevo): `shopDomain` unique, `duplicatePolicy`, `supplierPriority`, `maxSuppliers`
- `DuplicateLog` (nuevo): tracking de duplicados entre proveedores
- `ProductMapping`: + `ean` (String?, para detección de duplicados), `shopifyVariantId`, `shopifyInventoryItemId`
- `ImportLog` + `BulkJob`: + `excludedCount Int @default(0)`
- `BulkJobOp`: `shopifyOpId String? @unique`, `status` (pending/launched/processing/processed/failed), `startedAt`
- `BulkJob.phase`: lookup | mutations | finalizing | done | failed

## Archivos relevantes
- `app/routes/_index.tsx`: Dashboard principal (lista proveedores, crear/eliminar)
- `app/routes/app._index.tsx`: Dashboard dentro del layout /app
- `app/routes/app.tsx`: Layout con NavMenu (Proveedores, Duplicados badge, Configuración)
- `app/routes/app.supplier.$id.tsx`: Detalle proveedor con tabs
- `app/routes/app.supplier.$id.config.tsx`: Configuración del proveedor (URL/file upload, delimitador, modo, frecuencia, exclusiones)
- `app/routes/app.supplier.$id.columns.tsx`: Mapeo de columnas
- `app/routes/app.supplier.$id.price-rules.tsx`: Reglas de precio
- `app/routes/app.supplier.$id.category-mapping.tsx`: Mapeo categorías
- `app/routes/app.supplier.$id.preview.tsx`: Preview con columna duplicados
- `app/routes/app.supplier.$id.logs.tsx`: Historial
- `app/routes/app.settings.tsx`: Configuración general (política duplicados, prioridad)
- `app/routes/app.duplicates.tsx`: Duplicados detectados
- `app/routes/api.upload.tsx`: Upload de archivos
- `app/lib/bulk-import.server.ts`: pipeline bulk + resume + duplicate detection
- `app/lib/import-engine.server.ts`: motor chunks + duplicate detection
- `app/lib/duplicate-detection.server.ts`: checkDuplicate(), logDuplicate()
- `app/lib/csv-parser.server.ts`: streamCSV, streamExcel, streamFile, fetchCSVHeaders, isExcluded
- `app/lib/db.server.ts`: prisma, getOrCreateConfig, getConfigById
- `prisma/schema.prisma`: ImportConfig (N:1), ShopSettings, DuplicateLog, ProductMapping (ean)
- `MULTI-SUPPLIER.md`: Documentación de la arquitectura multi-proveedor

## Siguientes pasos
- Tunnel HTTPS + credenciales; verificar OAuth y registro de webhooks
- Migrar upload a Supabase Storage cuando se configure
