# Planificación — Multi-Proveedor

## Estado actual ✅ COMPLETADO
- **Multi-proveedor funcional**: schema, dashboard, CRUD, rutas, duplicados, Excel, upload
- App con N proveedores por tienda
- CSV URL + upload de archivos (CSV/Excel) local
- Detección de duplicados entre proveedores (3 políticas configurables)
- Configuración general con prioridad de proveedores
- Página de duplicados con badges
- Build limpio, sin errores TypeScript

---

## Arquitectura implementada

### Schema
- `ImportConfig` (N por shop): name, csvUrl, columnMaps, priceRules, categoryMaps, logs, products
- `ShopSettings` (1 por shop): duplicatePolicy, supplierPriority, maxSuppliers
- `DuplicateLog` (N por shop): tracking de duplicados entre proveedores
- `ProductMapping`: añadido campo `ean` para detección de duplicados

### Rutas
- `/app` → Dashboard principal (lista proveedores)
- `/app/supplier/:id` → Detalle proveedor con tabs
- `/app/supplier/:id/config` → Configuración del proveedor
- `/app/supplier/:id/columns` → Mapeo de columnas
- `/app/supplier/:id/price-rules` → Reglas de precio
- `/app/supplier/:id/category-mapping` → Mapeo categorías
- `/app/supplier/:id/preview` → Preview de importación
- `/app/supplier/:id/logs` → Historial
- `/app/settings` → Configuración general (política duplicados, prioridad)
- `/app/duplicates` → Duplicados detectados
- `/api/upload` → Upload de archivos

### Funcionalidades
- Crear/editar/eliminar proveedores
- Upload de archivos CSV/Excel (almacenamiento local)
- Detección de duplicados: create_both, priority, skip_existing
- Prioridad de proveedores configurable
- Badge de duplicados en NavMenu
- Preview muestra columna "Duplicado" con proveedor origen
- Soporte Excel (.xlsx, .xls, .ods) además de CSV

### Pendiente (cuando se configure Supabase)
- Migrar upload a Supabase Storage (archivos persistentes, TTL 24h)
- Cron automático para limpieza de archivos temporales
