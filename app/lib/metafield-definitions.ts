export interface MetafieldDefinitionInput {
  name: string;
  namespace: string;
  key: string;
  type: string;
  description?: string;
}

export const METAFIELD_DEFINITIONS: Record<string, MetafieldDefinitionInput> = {
  supplier_sku: {
    name: "SKU Proveedor",
    namespace: "custom",
    key: "supplier_sku",
    type: "single_line_text_field",
    description: "SKU del producto en el proveedor",
  },
  costo: {
    name: "Coste Proveedor",
    namespace: "custom",
    key: "costo",
    type: "number_decimal",
    description: "Precio de coste original del proveedor (sin markup)",
  },
  supplier_url: {
    name: "URL Proveedor",
    namespace: "custom",
    key: "supplier_url",
    type: "url",
    description: "URL del producto en el catálogo del proveedor",
  },
  tipo_producto: {
    name: "Tipo de Producto",
    namespace: "custom",
    key: "tipo_producto",
    type: "single_line_text_field",
    description: "Tipo de producto del catálogo del proveedor",
  },
  description_tag: {
    name: "Meta Descripción SEO",
    namespace: "global",
    key: "description_tag",
    type: "single_line_text_field",
    description: "Meta description para SEO",
  },
};

const CREATE_DEFINITION_MUTATION = `#graphql
  mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id key namespace }
      userErrors { field message code }
    }
  }`;

/**
 * Asegura que existen las metafield definitions de producto en la tienda antes
 * de importar (sin ellas, productCreate/productUpdate fallan con userErrors por
 * metafield). Idempotente: consulta lo existente y solo crea lo que falta.
 * Lanza solo si el API falla de forma inesperada.
 */
export async function ensureMetafieldDefinitions(admin: any): Promise<{
  created: string[];
  alreadyExisting: string[];
  errors: string[];
}> {
  const result: { created: string[]; alreadyExisting: string[]; errors: string[] } = {
    created: [],
    alreadyExisting: [],
    errors: [],
  };

  const existing = await fetchNamespaceKeys(admin, result);
  if (!existing) return result;

  for (const definition of Object.values(METAFIELD_DEFINITIONS)) {
    const definitionKey = `${definition.namespace}:${definition.key}`;
    if (existing.has(definitionKey)) {
      result.alreadyExisting.push(definitionKey);
      continue;
    }

    try {
      const response = await admin.graphql(CREATE_DEFINITION_MUTATION, {
        variables: {
          definition: {
            name: definition.name,
            namespace: definition.namespace,
            key: definition.key,
            type: definition.type,
            description: definition.description,
            ownerType: "PRODUCT",
            access: { admin: "ADMIN_READ_WRITE", storefront: "NONE" },
          },
        },
      });
      const json = await response.json();
      const errors = json.data?.metafieldDefinitionCreate?.userErrors || [];

      if (errors.length > 0) {
        const alreadyExists = errors.some((e: any) =>
          /already|exist/i.test(e.message || "")
        );
        if (alreadyExists) {
          result.alreadyExisting.push(definitionKey);
        } else {
          result.errors.push(
            `${definitionKey}: ${errors.map((e: any) => e.message).join("; ")}`
          );
        }
        continue;
      }

      result.created.push(definitionKey);
    } catch (error: any) {
      result.created.push(definitionKey);
      result.errors.push(`${definitionKey}: ${error?.message || "error de API"}`);
    }
  }

  return result;
}

async function fetchNamespaceKeys(admin: any, result: { errors: string[] }): Promise<Set<string> | null> {
  const existing = new Set<string>();

  try {
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const response: any = await admin.graphql(
        `#graphql
        query($cursor: String) {
          metafieldDefinitions(first: 250, ownerType: PRODUCT, after: $cursor) {
            edges {
              node { namespace key }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { variables: { cursor } }
      );

      const json: any = await response.json();
      const edges = json.data?.metafieldDefinitions?.edges || [];
      const pageInfo: any = json.data?.metafieldDefinitions?.pageInfo;

      for (const edge of edges) {
        existing.add(`${edge.node.namespace}:${edge.node.key}`);
      }

      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
      cursor = pageInfo.endCursor;
    }
  } catch (error: any) {
    result.errors.push(`query definiciones: ${error?.message || "error de API"}`);
    return null;
  }

  return existing;
}

export const SHOP_FIELDS = [
  { value: "title", label: "Nombre", required: true },
  { value: "description", label: "Descripción", required: false },
  { value: "short_description", label: "Descripción corta (SEO)", required: false },
  { value: "sku", label: "SKU (identificador)", required: true },
  { value: "ean", label: "EAN (código de barras)", required: false },
  { value: "price", label: "Precio", required: true },
  { value: "quantity", label: "Cantidad stock", required: false },
  { value: "category", label: "Categoría", required: false },
  { value: "brand", label: "Marca / Vendor", required: false },
  { value: "tipo_producto", label: "Tipo producto", required: false },
  { value: "weight", label: "Peso", required: false },
  { value: "image1", label: "Imagen 1 (principal)", required: false },
  { value: "image2", label: "Imagen 2", required: false },
  { value: "image3", label: "Imagen 3", required: false },
  { value: "image4", label: "Imagen 4", required: false },
  { value: "image5", label: "Imagen 5", required: false },
];
