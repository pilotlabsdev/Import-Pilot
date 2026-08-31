# PLAN: App Shopify - Importador de Productos MediaMax

## Resumen del Proyecto

App embebida en Shopify Admin que importa productos de un proveedor (MediaMax) desde un CSV remoto. Importación programada configurable por el usuario con reglas de precio jerárquicas y preview antes de importar.

**Fuente de datos:**
- URL: `https://api.mediamax.es/feeds/magento_b2b_b3778c166-7209-11ec-90d6-0242ac120003.csv`
- Formato: CSV separado por `|` (pipe), comillas dobles, encoding UTF-8
- Campos: SKU, EAN, name, short_description, description, category, tipo_producto, quantity, precio_mediamax_b, link, image1-image5, is_in_stock, weight, brand, estado_producto, outlet

---

## Decisiones Clave

| Decisión | Elección |
|----------|----------|
| Tipo de app | Embebida (React Router + Polaris) |
| Producto ausente en CSV | No hacer nada (dejar como está) |
| Estructura de producto | Producto simple (cada SKU = 1 producto Shopify) |
| Frecuencia de importación | Configurable desde la UI |
| Estado de productos | Borrador al crear (configurable); al actualizar se respeta el actual |
| Almacén destino | MDM (ya existe en la tienda) |
| Detección de duplicados | Por SKU (metacampo `custom:supplier_sku`) |
| Base de datos | SQLite con Prisma (viene con template React Router) |
| Preview | Sí - mostrar cambios de precio y stock antes de importar |
| Notificaciones | Sí - al completar importación |
| Reglas de precio | Jerárquicas: producto > categoría > general |

---

## Reglas de Precio (Jerarquía de Prioridad)

**Prioridad de mayor a menor:**
1. **Individual** (producto específico) — prioridad 1
2. **Por categoría** del proveedor — prioridad 2
3. **General** (proveedor/global) — prioridad 3

El sistema busca en orden de prioridad. Si encuentra una regla individual para el SKU, la usa. Si no, busca una regla para la categoría del producto. Si no, usa la regla general del proveedor.

**Ejemplo:**
```
General (proveedor):    +15% markup
Categoría "Electrónica": +25% markup
Categoría "Ropa":        +10% markup
SKU "ABC-123":           +5% markup

→ Producto ABC-123 en categoría "Electrónica": usa +5% (individual)
→ Producto XYZ-789 en categoría "Electrónica": usa +25% (categoría)
→ Producto DEF-456 en categoría "Hogar":       usa +15% (general)
```

---

## Arquitectura

### Stack Tecnológico

```
┌─────────────────────────────────────────────────────┐
│  Shopify Admin (iframe)                             │
│  ┌───────────────────────────────────────────────┐  │
│  │  App React (React Router v7 + Polaris)        │  │
│  │  - UI: Dashboard, Config, Preview, Logs       │  │
│  │  - Auth: via @shopify/shopify-app-react-router│  │
│  └──────────────────┬────────────────────────────┘  │
└─────────────────────┼───────────────────────────────┘
                      │ GraphQL (Admin API)
┌─────────────────────┼───────────────────────────────┐
│  Server (Remix/RR)  │                               │
│  ┌──────────────────┴────────────────────────────┐  │
│  │  - Autenticación OAuth + Sessions             │  │
│  │  - Parser CSV (streaming)                     │  │
│  │  - Mapeo CSV → Shopify productSet input       │  │
│  │  - Motor de reglas de precio                  │  │
│  │  - Preview engine (diff de cambios)           │  │
│  │  - Job Queue para importaciones               │  │
│  │  - Scheduler (node-cron)                      │  │
│  │  - Notificaciones (email webhook)             │  │
│  └───────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────┐  │
│  │  SQLite (Prisma)                              │  │
│  │  - sessions (Shopify OAuth)                   │  │
│  │  - import_configs (URL, frecuencia)           │  │
│  │  - price_rules (reglas jerárquicas)           │  │
│  │  - import_logs (historial)                    │  │
│  │  - product_mappings (SKU → Shopify product ID)│  │
│  │  - notifications (config de notificaciones)   │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### Estructura de Archivos del Proyecto

```
importador-mediamax/
├── app/
│   ├── routes/
│   │   ├── _index.tsx                    # Home/redirect
│   │   ├── app._index.tsx                # Dashboard principal
│   │   ├── app.config.tsx                # Configuración general
│   │   ├── app.columns.tsx               # Mapeo de columnas CSV
│   │   ├── app.price-rules.tsx           # Gestión de reglas de precio
│   │   ├── app.category-mapping.tsx      # Mapeo categorías → colecciones
│   │   ├── app.preview.tsx               # Preview antes de importar
│   │   ├── app.import.tsx                # Trigger manual de importación
│   │   ├── app.logs.tsx                  # Historial de importaciones
│   │   ├── api.import.tsx                # API endpoint para cron
│   │   ├── api.preview.tsx               # API para generar preview
│   │   └── api.webhook.tsx               # Webhooks de Shopify
│   ├── components/
│   │   ├── ImportDashboard.tsx           # Vista principal con stats
│   │   ├── ConfigForm.tsx                # Formulario configuración general
│   │   ├── PriceRulesTable.tsx           # Tabla de reglas de precio
│   │   ├── PriceRuleForm.tsx             # Formulario crear/editar regla
│   │   ├── ImportPreview.tsx             # Tabla de preview con diff
│   │   ├── ImportLogs.tsx                # Tabla de logs
│   │   ├── ImportButton.tsx              # Botón de importación manual
│   │   ├── NotificationSettings.tsx      # Config de notificaciones
│   │   └── PriceDisplay.tsx              # Componente precio con diff
│   ├── lib/
│   │   ├── shopify.server.ts             # Config Shopify (template)
│   │   ├── csv-parser.server.ts          # Parser CSV streaming
│   │   ├── formula-parser.server.ts      # Parser de fórmulas (safe-eval)
│   │   ├── product-mapper.server.ts      # Mapeo CSV → productSet input
│   │   ├── price-rules.server.ts         # Motor de reglas de precio
│   │   ├── preview-engine.server.ts      # Generador de preview
│   │   ├── import-engine.server.ts       # Motor de importación
│   │   ├── scheduler.server.ts           # Scheduler de importaciones
│   │   ├── notifications.server.ts       # Servicio de notificaciones
│   │   ├── location.server.ts            # Helper para obtener location MDM
│   │   ├── collections.server.ts         # Helper para listar colecciones
│   │   └── metafield-definitions.ts      # Definición de metafields
│   └── types/
│       ├── csv.types.ts                  # Tipos del CSV MediaMax
│       └── shopify.types.ts              # Tipos extendidos de Shopify
├── prisma/
│   └── schema.prisma                     # DB schema
├── shopify.app.toml                      # Config de la app
├── package.json
└── tsconfig.json
```

---

## Base de Datos (Prisma Schema)

```prisma
model ImportConfig {
  id              String   @id @default(cuid())
  shopDomain      String   @unique
  csvUrl          String
  csvDelimiter    String   @default("|")             // Delimitador del CSV
  frequency       String   @default("daily")
  cronExpression  String   @default("0 2 * * *")
  productStatus   String   @default("DRAFT")        // "DRAFT" o "ACTIVE"
  importMode      String   @default("chunks")       // "chunks" o "bulk"
  chunkSize       Int      @default(50)             // Tamaño del lote (solo modo chunks)
  maxRetries      Int      @default(3)              // Reintentos por producto
  isActive        Boolean  @default(true)
  lastImportAt    DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  logs            ImportLog[]
  products        ProductMapping[]
  priceRules      PriceRule[]
  categoryMaps    CategoryCollectionMapping[]
  columnMaps      ColumnMapping[]
  notifications   NotificationConfig?
}

model ColumnMapping {
  id              String   @id @default(cuid())
  configId        String
  shopifyField    String                              // Campo destino en Shopify
  csvColumn       String?                             // Nombre de la columna en el CSV (null = no mapear)
  isRequired      Boolean  @default(false)            // Campo obligatorio
  defaultValue    String?                             // Valor por defecto si la columna no existe
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  config          ImportConfig @relation(fields: [configId], references: [id])

  @@unique([configId, shopifyField])
}

model CategoryCollectionMapping {
  id              String   @id @default(cuid())
  configId        String
  shopDomain      String
  csvCategory     String                              // Categoría del CSV (ej: "Tablets")
  collectionId    String                              // gid://shopify/Collection/xxx
  collectionName  String                              // Nombre para display
  isActive        Boolean  @default(true)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  config          ImportConfig @relation(fields: [configId], references: [id])

  @@unique([shopDomain, csvCategory])
}

model PriceRule {
  id              String   @id @default(cuid())
  configId        String
  shopDomain      String
  name            String                              // Nombre descriptivo
  priority        Int       @default(3)               // 1=producto, 2=categoría, 3=general
  ruleType        String                              // "general", "category", "product"
  targetValue     String?                             // SKU (product) o nombre categoría
  // Fórmula de precio regular (C = precio de coste/proveedor)
  priceFormula    String   @default("C")              // Ej: "C*1.262*1.08*1.0605+9,0"
  // Fórmula de precio de comparación (opcional)
  comparePriceEnabled Boolean @default(false)
  comparePriceFormula  String @default("C")           // Misma sintaxis que priceFormula
  // Redondeo
  roundingType    String   @default("none")           // "none", "0.95", "0.99", "custom"
  roundingCustom  Float?                              // Valor custom (ej: 0.97)
  isActive        Boolean  @default(true)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  config          ImportConfig @relation(fields: [configId], references: [id])

  @@unique([shopDomain, ruleType, targetValue])
}

model CategoryCollectionMapping {
  id              String   @id @default(cuid())
  configId        String
  shopDomain      String
  csvCategory     String                              // Categoría del CSV (ej: "Tablets")
  collectionId    String                              // gid://shopify/Collection/xxx
  collectionName  String                              // Nombre para display
  isActive        Boolean  @default(true)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  config          ImportConfig @relation(fields: [configId], references: [id])

  @@unique([shopDomain, csvCategory])
}

model ImportLog {
  id              String   @id @default(cuid())
  shopDomain      String
  configId        String
  status          String   @default("running")       // "running", "completed", "failed", "cancelled"
  triggerType     String   @default("scheduled")     // "scheduled", "manual"
  totalProducts   Int      @default(0)
  created         Int      @default(0)
  updated         Int      @default(0)
  unchanged       Int      @default(0)
  priceChanges    Int      @default(0)               // Productos con cambio de precio
  stockChanges    Int      @default(0)               // Productos con cambio de stock
  errors          String?                             // JSON array de errores
  previewData     String?                             // JSON con datos del preview
  startedAt       DateTime @default(now())
  completedAt     DateTime?
  config          ImportConfig @relation(fields: [configId], references: [id])
}

model ProductMapping {
  id                String   @id @default(cuid())
  shopDomain        String
  configId          String
  supplierSku       String
  shopifyProductId  String                           // gid://shopify/Product/xxx
  lastPrice         Float?                           // Último precio aplicado
  lastQuantity      Int?                             // Última cantidad importada
  lastSyncAt        DateTime @default(now())
  config            ImportConfig @relation(fields: [configId], references: [id])

  @@unique([shopDomain, supplierSku])
}

model NotificationConfig {
  id              String   @id @default(cuid())
  configId        String   @unique
  shopDomain      String
  emailEnabled    Boolean  @default(false)
  emailAddresses  String?                            // JSON array de emails
  webhookEnabled  Boolean  @default(false)
  webhookUrl      String?
  notifyOnSuccess Boolean  @default(true)
  notifyOnError   Boolean  @default(true)
  notifyOnPriceChange Boolean @default(false)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  config          ImportConfig @relation(fields: [configId], references: [id])
}
```

---

## Flujo de Importación

### 1. Descarga y Parseo del CSV

```typescript
// csv-parser.server.ts
// Streaming parser para CSV pipe-separated
// Proceso:
// 1. Fetch del CSV remoto con fetch() nativo (streaming)
// 2. Parseo línea por línea
// 3. Skip header row
// 4. Return AsyncGenerator<ProductRow>
```

### 2. Motor de Reglas de Precio (Fórmulas)

```typescript
// price-rules.server.ts
//
// Variable disponible en fórmulas:
//   C = precio de coste/proveedor (precio_mediamax_b del CSV)
//
// Sintaxis de fórmulas soportada:
//   Operadores: * (multiplicar), + (sumar), - (restar), / (dividir)
//   Paréntesis: ( y ) para agrupar
//   Decimales: punto (.) o coma (,) como separador decimal
//
// Ejemplos de fórmulas:
//   "C*1.262*1.08*1.0605+9,0"     → C × 1.262 × 1.08 × 1.0605 + 9.0
//   "C*1.262*(1.08*1.0605)+9,0"   → C × 1.262 × (1.08 × 1.0605) + 9.0
//   "C*1.262"                      → Solo markup del 26.2%
//   "(C+5)*1.21"                   → Sumar 5€ y aplicar IVA 21%
//   "C*1.15+2.50"                  → 15% markup + 2.50€ fijo
//
// Redondeo (se aplica AL FINAL del cálculo):
//   "none"  → sin redondeo
//   "0.95"  → redondear a .95 (ej: 12.34 → 12.95? No, se redondea al 0.95 más cercano)
//   "0.99"  → redondear a .99 (ej: 12.34 → 12.99)
//   "custom"→ usar valor custom (ej: 0.97)
//
// Algoritmo de búsqueda (prioridad):
// 1. Buscar regla por SKU (prioridad 1, ruleType="product")
// 2. Si no existe, buscar regla por categoría (prioridad 2, ruleType="category")
// 3. Si no existe, usar regla general (prioridad 3, ruleType="general")
// 4. Si no hay regla general, usar C (precio base sin cambio)
//
// Retorna: {
//   regularPrice: number,
//   compareAtPrice: number | null,
//   appliedRule: PriceRule | null
// }
```

**Parser de fórmulas (safe-eval):**
```typescript
// formula-parser.server.ts
//
// NO se usa eval() por seguridad
// Se implementa un parser recursivo de expresiones:
//
// 1. Normalizar: reemplazar coma por punto
// 2. Tokenizar: número, operador, paréntesis
// 3. Parsear con gramática de expresiones aritméticas
// 4. Evaluar con C sustituido por el precio real
//
// Gramática soportada:
//   expression = term (('+' | '-') term)*
//   term       = factor (('*' | '/') factor)*
//   factor     = number | 'C' | '(' expression ')'
//   number     = [0-9]+ ('.' [0-9]+)?
```

### 3. Mapeo a productSet Input

```typescript
// product-mapper.server.ts
//
// Lee los ColumnMapping de la DB para saber qué columna del CSV
// corresponde a cada campo de Shopify.
//
// Función: mapCsvRowToProductSet(row, config, prices, collections, columnMaps) => ProductSetInput
//
// Mapeo dinámico basado en columnMaps:
// {
//   title: row[columnMaps.find(m => m.shopifyField === "title").csvColumn],
//   descriptionHtml: row[columnMaps.find(m => m.shopifyField === "description").csvColumn],
//   productType: row[columnMaps.find(m => m.shopifyField === "category").csvColumn],
//   vendor: row[columnMaps.find(m => m.shopifyField === "brand").csvColumn],
//   tags: [row[columnMaps.find(... "outlet")]].filter(Boolean),
//   metafields: [
//     { namespace: "custom", key: "supplier_sku",
//       value: row[columnMaps.find(m => m.shopifyField === "sku").csvColumn] },
//     { namespace: "custom", key: "costo",
//       value: row[columnMaps.find(m => m.shopifyField === "price").csvColumn] },
//     { namespace: "custom", key: "tipo_producto",
//       value: row[columnMaps.find(m => m.shopifyField === "tipo_producto").csvColumn] },
//     { namespace: "custom", key: "google_condition",
//       value: row[columnMaps.find(m => m.shopifyField === "estado_producto").csvColumn] },
//     { namespace: "global", key: "description_tag",
//       value: row[columnMaps.find(m => m.shopifyField === "short_description").csvColumn] }
//   ],
//   seo: { description: row[short_description column] },
//   files: images.filter(f => f.originalSource).map(...),  // Solo imágenes con valor
//   variants: [{
//     price: prices.regularPrice,
//     compareAtPrice: prices.compareAtPrice,
//     barcode: row[ean column],
//     inventoryQuantities: [{ locationId, name: "available", quantity }],
//     inventoryPolicy: "DENY",
//     weight: row[weight column],
//     weightUnit: "kg",
//     file: { originalSource: row[image1 column] }
//   }],
//   collections: collections.map(c => c.collectionId)
// }
```

### 4. Preview de Cambios

```typescript
// preview-engine.server.ts
//
// Función: generatePreview(csvRows: ProductRow[], config: ImportConfig)
//
// Proceso:
// 1. Para cada fila del CSV:
//    a. Buscar producto existente por SKU en ProductMapping
//    b. Si existe: comparar precio actual vs nuevo, stock actual vs nuevo
//    c. Si no existe: marcar como "nuevo"
// 2. Retornar array de PreviewItem:
//    {
//      sku, name, status: "new" | "updated" | "unchanged",
//      currentPrice, newPrice, priceChange,
//      currentStock, newStock, stockChange,
//      imageUrl, category
//    }
// 3. Ordenar por: cambios de precio primero, luego stock, luego nuevos
```

### 4. Ejecución de Importación

```typescript
// import-engine.server.ts
//
// Flujo completo de importación:
// 1. Parsear CSV y obtener todos los SKUs del feed
// 2. Determinar modo de importación:
//    - "chunks": procesar de config.chunkSize en chunkSize (default: 50)
//    - "bulk": usar bulkOperationRunMutation para todo el CSV
//
// 3. Para cada producto del CSV:
//    a. Buscar en ProductMapping por supplierSku
//    b. Calcular precios con fórmulas jerárquicas (regular + comparación)
//       ⚠️ El precio del CSV es SIN IVA. El IVA se calcula en la fórmula.
//    c. Buscar colecciones mapeadas para la categoría del producto
//    d. Si existe → productUpdate (mutation con id del producto)
//       ⚠️ NO se modifica el status del producto (se respeta el actual)
//    e. Si no existe → productCreate (mutation)
//       ✅ Se aplica config.productStatus ("DRAFT" o "ACTIVE")
//    f. Asignar producto a colecciones mapeadas
//    g. Actualizar ProductMapping con precio y cantidad
//    h. Si falla → reintentar hasta config.maxRetries veces
//       Si aún falla → loggear error detallado y continuar con el siguiente
//
// 4. Después de procesar todos los productos del CSV:
//    ⚠️ Productos en ProductMapping que NO están en el CSV actual:
//    → Poner stock a 0 en la ubicación MDM
//    → NO eliminar el producto
//    → NO modificar el status (se mantiene como está)
//
// 5. Obtener locationId del almacén MDM
//
// Mapeo CSV → Shopify:
// - brand → vendor (campo nativo de Shopify)
// - category → productType + collections (via CategoryCollectionMapping)
// - ean → barcode (código de barras del variant)
// - weight → variant weight + weightUnit
// - precio_mediamax_b → variant price (con fórmula) + metafield custom:costo (sin modificar)
// - short_description → SEO meta description
// - description → descriptionHtml
// - tipo_producto → metafield custom:tipo_producto
// - estado_producto → metafield custom:google_condition
//
// Almacén MDM: Se obtiene el locationId dinámicamente
// via la query `locations(first: 10)` y filtrando por nombre "MDM"
//
// Estado de productos:
// - CREACIÓN: se aplica config.productStatus (DRAFT por defecto)
// - ACTUALIZACIÓN: NO se modifica el status (se mantiene el actual)
//
// Productos ausentes del CSV:
// - Stock → 0 en ubicación MDM
// - Status → se mantiene actual
// - NO se eliminan
//
// Manejo de errores:
// - Retry: reintentar hasta maxRetries veces por producto
// - Skip: si agota reintentos, loggear error y continuar
// - Log: guardar error detallado en ImportLog.errors (JSON)
// - No detener la importación por un solo producto
```

### 5. Notificaciones

```typescript
// notifications.server.ts
//
// Después de cada importación:
// 1. Leer NotificationConfig
// 2. Si emailEnabled → enviar resumen vía Shopify email API
//    - Asunto: "Importación completada - X productos actualizados"
//    - Contenido: resumen de cambios, errores si los hay
// 3. Si webhookEnabled → POST a webhookUrl con payload JSON
// 4. Respetar flags: notifyOnSuccess, notifyOnError, notifyOnPriceChange
```

---

## UI (Polaris Components)

### Configuración General (`app.config.tsx`)

```
┌─────────────────────────────────────────────────────┐
│  Configuración de Importación                       │
├─────────────────────────────────────────────────────┤
│                                                     │
│  URL del CSV:                                       │
│  [https://api.mediamax.es/feeds/...csv          ]  │
│                                                     │
│  Delimitador CSV:  [| ▼]                            │
│                                                     │
│  Frecuencia:         [Diaria ▼]                     │
│                                                     │
│  Estado productos:   [Borrador ▼]                   │
│                      (Borrador / Activos)           │
│                                                     │
│  Modo importación:   [Chunks ▼]                     │
│                      (Chunks / Bulk Operation)      │
│  Tamaño lote:        [ 50 ] (solo modo chunks)      │
│  Reintentos:         [  3 ]                         │
│                                                     │
│  [💾 Guardar Configuración]                         │
│                                                     │
│  ──────────────────────────────────────────────    │
│                                                     │
│  Próxima importación: 19/08/2026 02:00              │
└─────────────────────────────────────────────────────┘
```

### Mapeo de Columnas CSV (`app.columns.tsx`)

```
┌─────────────────────────────────────────────────────────────────┐
│  Mapeo de Columnas CSV                                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  La app detecta las columnas del CSV automáticamente.           │
│  Selecciona qué columna corresponde a cada campo de Shopify:   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Campo Shopify       │ Columna CSV      │ Requerido│Def. │   │
│  ├─────────────────────┼──────────────────┼──────────┼─────┤   │
│  │ SKU (identificador) │ [SKU ▼]          │ ✅       │     │   │
│  │ EAN (barras)        │ [ean ▼]          │          │     │   │
│  │ Nombre              │ [name ▼]         │ ✅       │     │   │
│  │ Descripción         │ [description ▼]  │          │     │   │
│  │ Descripción corta   │ [short_desc ▼]   │          │     │   │
│  │ Categoría           │ [category ▼]     │          │     │   │
│  │ Tipo producto       │ [tipo_producto▼] │          │     │   │
│  │ Precio              │ [precio_media▼]  │ ✅       │     │   │
│  │ Cantidad stock      │ [quantity ▼]     │          │     │   │
│  │ En stock            │ [is_in_stock ▼]  │          │     │   │
│  │ Peso                │ [weight ▼]       │          │     │   │
│  │ Marca               │ [brand ▼]        │          │     │   │
│  │ Estado producto     │ [estado_prod ▼]  │          │     │   │
│  │ Outlet              │ [outlet ▼]       │          │     │   │
│  │ Link proveedor      │ [link ▼]         │          │     │   │
│  │ Imagen 1 (principal)│ [image1 ▼]       │          │     │   │
│  │ Imagen 2            │ [image2 ▼]       │          │     │   │
│  │ Imagen 3            │ [image3 ▼]       │          │     │   │
│  │ Imagen 4            │ [image4 ▼]       │          │     │   │
│  │ Imagen 5            │ [image5 ▼]       │          │     │   │
│  └─────────────────────┴──────────────────┴──────────┴─────┘   │
│                                                                 │
│  Los desplegables muestran las columnas detectadas del CSV.    │
│  Si una columna no existe en el CSV, se puede dejar vacío      │
│  o asignar un valor por defecto.                               │
│                                                                 │
│  [💾 Guardar Mapeo]  [🔄 Re.detectar columnas]                │
└─────────────────────────────────────────────────────────────────┘
```

### Dashboard (`app._index.tsx`)

```
┌─────────────────────────────────────────────────────┐
│  Importador MediaMax                    [⚙️ Config] │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐│
│  │ Products │ │ Imported │ │  Errors  │ │Changes ││
│  │   1,234  │ │   1,200  │ │    12    │ │   45   ││
│  └──────────┘ └──────────┘ └──────────┘ └────────┘│
│                                                     │
│  Última importación: hace 2 horas                  │
│  [🔄 Importar Ahora] [📊 Ver Preview]              │
│                                                     │
│  Últimas 5 importaciones:                          │
│  ┌─────────────────────────────────────────────┐   │
│  │ ✅ 18/08 02:00 - 1,234 products - 2m 45 $ │   │
│  │ ✅ 17/08 02:00 - 1,230 products - 2m 12 $ │   │
│  │ ❌ 16/08 02:00 - Error de conexión          │   │
│  └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Preview de Importación (`app.preview.tsx`)

```
┌─────────────────────────────────────────────────────┐
│  Preview de Importación                    [← Volver]│
├─────────────────────────────────────────────────────┤
│                                                     │
│  Resumen: 1,234 productos | 45 cambios precio      │
│           | 120 cambios stock | 12 nuevos           │
│                                                     │
│  Filtros: [Todos] [Solo cambios] [Solo nuevos]     │
│                                                     │
│  Buscar: [____________________]                     │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │ SKU     │ Producto  │ Precio    │ Stock     │   │
│  ├─────────┼───────────┼───────────┼───────────┤   │
│  │ ABC-123 │ Widget A  │ 10→12 ⬆️  │ 50→45 ⬇️ │   │
│  │ DEF-456 │ Widget B  │ 8→8  ═    │ 0→30  ⬆️ │   │
│  │ GHI-789 │ Widget C  │ [NUEVO]   │ [NUEVO]   │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│  [❌ Cancelar]  [✅ Confirmar Importación]          │
└─────────────────────────────────────────────────────┘
```

### Configuración de Reglas de Precio (`app.price-rules.tsx`)

```
┌─────────────────────────────────────────────────────────────────┐
│  Reglas de Precio MediaMax                          [+ Nueva]   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Prioridad: 1 = Producto (máxima)                              │
│             2 = Categoría                                      │
│             3 = General (mínima)                               │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Tipo     │ Target      │ Fórmula           │ Rend.│Est.│   │
│  ├──────────┼─────────────┼───────────────────┼──────┼────┤   │
│  │ General  │ (global)    │ C*1.262*1.08*...  │ .99  │ ✅ │   │
│  │ Categoría│ Electrónica │ C*1.25+2.50       │ .95  │ ✅ │   │
│  │ Categoría│ Ropa        │ (C+3)*1.21        │ Ning.│ ✅ │   │
│  │ Producto │ ABC-123     │ C*1.15            │ .99  │ ✅ │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ─────────────────────────────────────────────────────────     │
│  Editar regla:                                                 │
│                                                                 │
│  Tipo:      [Categoría ▼]                                      │
│  Target:    [Electrónica    ]                                  │
│  Nombre:    [Electrónica Markup]                               │
│                                                                 │
│  Fórmula precio regular:                                       │
│  ┌───────────────────────────────────────────────────────┐     │
│  │ C*1.262*1.08*1.0605+9,0                              │     │
│  └───────────────────────────────────────────────────────┘     │
│  C = precio proveedor | Soporta: * + - / ( )                   │
│                                                                 │
│  Fórmula precio comparación:  [✅ Habilitar]                   │
│  ┌───────────────────────────────────────────────────────┐     │
│  │ C*1.50                                               │     │
│  └───────────────────────────────────────────────────────┘     │
│                                                                 │
│  Redondeo: [ .99 ▼ ]                                           │
│            (Ninguno / .95 / .99 / Personalizado)               │
│  Si personalizado: [___]                                        │
│                                                                 │
│  [Cancelar]  [Guardar Regla]                                   │
└─────────────────────────────────────────────────────────────────┘
```

### Mapeo Categoría → Colección (`app.category-mapping.tsx`)

```
┌─────────────────────────────────────────────────────────────────┐
│  Mapeo Categorías → Colecciones                    [+ Nuevo]    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Asocia las categorías del CSV con colecciones de Shopify:     │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Categoría CSV    │ Colección Shopify      │ Estado     │   │
│  ├──────────────────┼───────────────────────┼────────────┤   │
│  │ Tablets          │ Electrónica            │ ✅         │   │
│  │ Smartphones      │ Móviles                │ ✅         │   │
│  │ Portátiles       │ Computación            │ ✅         │   │
│  │ (sin mapear)     │ —                      │ —          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Las categorías sin mapear van solo a productType,             │
│  sin asignarse a ninguna colección                             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Scopes Necesarios (OAuth)

```toml
# shopify.app.toml
[access_scopes]
scopes = "write_products,read_products,read_inventory,write_inventory,read_locations,read_content"
```

- `read_locations`: Para obtener el ID del almacén MDM
- `read_content`: Para listar colecciones existentes

---

## Pasos de Implementación (Orden)

### Fase 1: Scaffold y Configuración Base
1. Scaffold con `shopify app init` (React Router template)
2. Configurar Prisma schema con los 5 modelos
3. Configurar OAuth scopes en `shopify.app.toml`
4. Definir metafields en `metafield-definitions.ts`

### Fase 2: Motor de Importación
5. Crear `csv-parser.server.ts` (parser streaming pipe-separated)
6. Crear `location.server.ts` (obtener locationId de MDM)
7. Crear `price-rules.server.ts` (motor de reglas jerárquicas)
8. Crear `product-mapper.server.ts` (mapeo CSV → productSet input)
9. Crear `import-engine.server.ts` (create/update products)

### Fase 3: Preview Engine
10. Crear `preview-engine.server.ts` (generador de preview)
11. Crear ruta `app.preview.tsx` con tabla de diff
12. Crear componente `ImportPreview.tsx` con filtros

### Fase 4: Scheduler y Notificaciones
13. Crear `scheduler.server.ts` (node-cron con config desde DB)
14. Crear `notifications.server.ts` (email + webhook)
15. Integrar scheduler → import → notifications

### Fase 5: UI
16. Dashboard con estadísticas de última importación
17. Formulario de configuración general
18. CRUD de reglas de precio jerárquicas
19. Configuración de notificaciones
20. Botón de importación manual

### Fase 6: API Endpoints
21. Endpoint para trigger manual de importación
22. Endpoint para generar preview
23. Endpoint para webhooks

### Fase 7: Testing y Polish
24. Test con el CSV real de MediaMax
25. Manejo de errores y edge cases
26. Rate limiting robusto

---

## Limitaciones a Considerar

- **CSV muy grande (>5MB)**: Usar streaming, no cargar todo en memoria
- **Rate limits GraphQL**: 1,000 products/day threshold después de 50k variantes
- **Bulk operations**: Max 5 concurrentes por app (API 2026-01+)
- **Imágenes**: Shopify descarga y almacena las URLs, deben ser accesibles públicamente
- **productCreate throttling**: Máximo 1,000 nuevas variantes/día tras 50k variants existentes
- **Preview**: Calcular diffs contra el estado actual de Shopify (requiere query de productos existentes)
- **Status de productos**: Solo se aplica al CREAR. Al ACTUALIZAR se respeta el status actual del producto
