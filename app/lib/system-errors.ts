/**
 * Maps hardcoded SYSTEM error strings (Spanish) to i18next translation keys.
 * Used for backward compatibility with old logs that stored Spanish strings.
 * New code should store translation keys directly.
 */
const SPANISH_TO_KEY: Record<string, string> = {
  "Cancelado manualmente": "systemError.cancelled_manually",
  "Replaced by resume": "systemError.replaced_by_resume",
  "Error desconocido": "systemError.unknown_error",
  "Timeout: no progress >15min": "systemError.timeout_no_progress",
  "Timeout: orphan, no progress >15min": "systemError.timeout_orphan",
  "SKU vacío": "systemError.empty_sku",
  "Error de variable": "systemError.variable_error",
  "Sin ID de producto en resultado": "systemError.no_product_id",
  "Producto eliminado de Shopify, mapping borrado": "systemError.product_deleted",
  "Error general": "systemError.general_error",
  "Sin ID de bulk query de productos existentes": "systemError.no_lookup_op_id",
  "Lookup nunca completó (posible token inválido). Reinstala la app y vuelve a intentar.": "systemError.lookup_never_completed",
  "Mutations sin manifest (posible fallo durante preparación).": "systemError.mutations_no_manifest",
  "Mutations sin progreso (webhooks de mutaciones no llegaron). Verifica los webhooks.": "systemError.mutations_no_progress",
  "Archivos de importación perdidos (redeploy). La importación debe reiniciarse.": "systemError.files_lost_redeploy",
  "No se pudo lanzar la bulk query de productos existentes (resume)": "systemError.resume_lookup_failed",
  "Job en fase mutations sin manifest (resume): imposible reanudar": "systemError.resume_no_manifest",
  "Error finalizando importación bulk": "systemError.finalize_error",
};

/**
 * Template literal patterns that contain dynamic values.
 * These are matched by prefix and the dynamic part is extracted.
 */
const TEMPLATE_PATTERNS: Array<{ prefix: string; key: string; extractVars: (s: string) => Record<string, string> }> = [
  {
    prefix: "La bulk query de productos existentes terminó con estado",
    key: "systemError.query_bad_status",
    extractVars: (s) => {
      const m = s.match(/estado "([^"]+)"/);
      return { status: m?.[1] || "unknown" };
    },
  },
  {
    prefix: "Operación bulk",
    key: "systemError.op_bad_status",
    extractVars: (s) => {
      const m = s.match(/Operación bulk (\w+) #(\d+) terminó con estado "([^"]+)"/);
      return { kind: m?.[1] || "", index: m?.[2] || "0", status: m?.[3] || "unknown" };
    },
  },
  {
    prefix: "Token inválido",
    key: "systemError.invalid_token",
    extractVars: (s) => {
      const m = s.match(/Token inválido: (.+)\. Reinstala/);
      return { msg: m?.[1] || s };
    },
  },
  {
    prefix: "Webhook BULK_OPERATIONS_FINISH nunca llegó",
    key: "systemError.webhook_never_arrived",
    extractVars: (s) => {
      const m = s.match(/lookup (\w+)/);
      return { opId: m?.[1] || "" };
    },
  },
  {
    prefix: "No hay sesión para",
    key: "systemError.no_session",
    extractVars: (s) => {
      const m = s.match(/No hay sesión para (\S+)/);
      return { shop: m?.[1] || "" };
    },
  },
  {
    prefix: "Job excedió tiempo máximo de vida",
    key: "systemError.job_too_old",
    extractVars: (s) => {
      const m = s.match(/\((\d+)min\)/);
      return { minutes: m?.[1] || "0" };
    },
  },
];

export interface TranslatedError {
  key: string;
  vars?: Record<string, string>;
}

/**
 * Converts a SYSTEM error string (possibly Spanish, possibly a translation key)
 * into a translation key with variables.
 */
export function parseSystemError(errorStr: string): TranslatedError {
  if (!errorStr) return { key: "systemError.unknown_error" };

  // Already a translation key
  if (errorStr.startsWith("systemError.")) {
    return { key: errorStr };
  }

  // Exact match from Spanish
  const exactKey = SPANISH_TO_KEY[errorStr];
  if (exactKey) return { key: exactKey };

  // Template literal patterns
  for (const pattern of TEMPLATE_PATTERNS) {
    if (errorStr.startsWith(pattern.prefix)) {
      return { key: pattern.key, vars: pattern.extractVars(errorStr) };
    }
  }

  // Unknown — return as-is (will display the original string)
  return { key: errorStr };
}
