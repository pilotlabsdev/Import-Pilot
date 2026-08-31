export const PLAN_HANDLES = {
  BASIC_MONTHLY: "basic-monthly",
  BASIC_ANNUAL: "basic-annual",
  GROWTH_MONTHLY: "growth-monthly",
  GROWTH_ANNUAL: "growth-annual",
  PRO_MONTHLY: "pro-monthly",
  PRO_ANNUAL: "pro-annual",
  BUSINESS_MONTHLY: "business-monthly",
  BUSINESS_ANNUAL: "business-annual",
} as const;

export const PLAN_LIMITS: Record<string, number> = {
  "basic-monthly": 1,
  "basic-annual": 1,
  "growth-monthly": 2,
  "growth-annual": 2,
  "pro-monthly": 3,
  "pro-annual": 3,
  "business-monthly": 5,
  "business-annual": 5,
};

export const PLAN_BASE_HANDLES: Record<string, string> = {
  "basic-monthly": "basic",
  "basic-annual": "basic",
  "growth-monthly": "growth",
  "growth-annual": "growth",
  "pro-monthly": "pro",
  "pro-annual": "pro",
  "business-monthly": "business",
  "business-annual": "business",
};

export const PLAN_INFO = [
  {
    handle: PLAN_HANDLES.BASIC_MONTHLY,
    baseHandle: "basic",
    name: "Basic",
    price: 24.99,
    billingType: "monthly",
    supplierCount: 1,
    limit: PLAN_LIMITS[PLAN_HANDLES.BASIC_MONTHLY],
  },
  {
    handle: PLAN_HANDLES.BASIC_ANNUAL,
    baseHandle: "basic",
    name: "Basic",
    price: 249.99,
    monthlyEquivalent: 249.99 / 12,
    billingType: "annual",
    supplierCount: 1,
    limit: PLAN_LIMITS[PLAN_HANDLES.BASIC_ANNUAL],
  },
  {
    handle: PLAN_HANDLES.GROWTH_MONTHLY,
    baseHandle: "growth",
    name: "Growth",
    price: 49.99,
    billingType: "monthly",
    supplierCount: 2,
    limit: PLAN_LIMITS[PLAN_HANDLES.GROWTH_MONTHLY],
  },
  {
    handle: PLAN_HANDLES.GROWTH_ANNUAL,
    baseHandle: "growth",
    name: "Growth",
    price: 499.99,
    monthlyEquivalent: 499.99 / 12,
    billingType: "annual",
    supplierCount: 2,
    limit: PLAN_LIMITS[PLAN_HANDLES.GROWTH_ANNUAL],
  },
  {
    handle: PLAN_HANDLES.PRO_MONTHLY,
    baseHandle: "pro",
    name: "Pro",
    price: 74.99,
    billingType: "monthly",
    supplierCount: 3,
    limit: PLAN_LIMITS[PLAN_HANDLES.PRO_MONTHLY],
  },
  {
    handle: PLAN_HANDLES.PRO_ANNUAL,
    baseHandle: "pro",
    name: "Pro",
    price: 749.99,
    monthlyEquivalent: 749.99 / 12,
    billingType: "annual",
    supplierCount: 3,
    limit: PLAN_LIMITS[PLAN_HANDLES.PRO_ANNUAL],
  },
  {
    handle: PLAN_HANDLES.BUSINESS_MONTHLY,
    baseHandle: "business",
    name: "Business",
    price: 124.99,
    billingType: "monthly",
    supplierCount: 5,
    limit: PLAN_LIMITS[PLAN_HANDLES.BUSINESS_MONTHLY],
  },
  {
    handle: PLAN_HANDLES.BUSINESS_ANNUAL,
    baseHandle: "business",
    name: "Business",
    price: 1249.99,
    monthlyEquivalent: 1249.99 / 12,
    billingType: "annual",
    supplierCount: 5,
    limit: PLAN_LIMITS[PLAN_HANDLES.BUSINESS_ANNUAL],
  },
];

export function getPlanInfo(handle: string) {
  return PLAN_INFO.find((p) => p.handle === handle);
}

export function getBaseHandle(handle: string): string {
  return PLAN_BASE_HANDLES[handle] || handle;
}

export function getMonthlyEquivalent(handle: string): number {
  const info = getPlanInfo(handle);
  if (!info) return 0;
  return info.billingType === "annual" ? info.monthlyEquivalent! : info.price;
}
