import { prisma } from "./db.server";
import { evaluateFormula, applyRounding } from "./formula-parser";

export interface PriceRange {
  min: number;
  max: number;
  formula: string;
  roundingType: string;
  roundingCustom?: number | null;
  compareEnabled: boolean;
  compareBasis: string;
  compareType: string;
  compareFormula: string;
  compareFixedValue?: number | null;
  comparePercentage?: number | null;
  compareRoundingType: string;
  compareRoundingCustom?: number | null;
}

export interface PriceResult {
  regularPrice: number;
  compareAtPrice: number | null;
  appliedRule: {
    id: string;
    name: string;
    priceFormula: string;
    comparePriceEnabled: boolean;
    comparePriceBasis: string;
    comparePriceType: string;
    comparePriceFormula: string;
    comparePriceFixedValue: number | null;
    comparePricePercentage: number | null;
    compareRoundingType: string;
    compareRoundingCustom: number | null;
    roundingType: string;
    roundingCustom: number | null;
  } | null;
}

type RuleRow = {
  id: string;
  name: string;
  ruleType: string;
  targetValue: string | null;
  priceFormula: string;
  priceRanges: any;
  comparePriceEnabled: boolean;
  comparePriceBasis: string;
  comparePriceType: string;
  comparePriceFormula: string;
  comparePriceFixedValue: number | null;
  comparePricePercentage: number | null;
  compareRoundingType: string;
  compareRoundingCustom: number | null;
  roundingType: string;
  roundingCustom: number | null;
};

function matchesTarget(targetValue: string | null, value: string): boolean {
  if (!targetValue) return false;
  try {
    const arr = JSON.parse(targetValue);
    if (Array.isArray(arr)) return arr.includes(value);
  } catch {}
  return targetValue === value;
}

function findRule(rules: RuleRow[], sku: string, category: string) {
  for (const rule of rules) {
    if (rule.ruleType === "product" && matchesTarget(rule.targetValue, sku)) return rule;
  }
  for (const rule of rules) {
    if (rule.ruleType === "category" && matchesTarget(rule.targetValue, category)) return rule;
  }
  for (const rule of rules) {
    if (rule.ruleType === "general") return rule;
  }
  return null;
}

function findPriceRange(rule: RuleRow, costPrice: number): PriceRange | null {
  if (!rule.priceRanges) return null;
  try {
    const ranges: PriceRange[] = Array.isArray(rule.priceRanges)
      ? rule.priceRanges
      : JSON.parse(rule.priceRanges as string);
    if (!Array.isArray(ranges) || ranges.length === 0) return null;
    const sorted = [...ranges].sort((a, b) => a.min - b.min);
    for (const r of sorted) {
      if (costPrice >= r.min && costPrice <= r.max) return r;
    }
    return sorted[sorted.length - 1];
  } catch {
    return null;
  }
}

function computeCompareAtPrice(
  basis: string,
  enabled: boolean,
  type: string,
  formula: string,
  fixedValue: number | null,
  percentage: number | null,
  roundingType: string,
  roundingCustom: number | null,
  costPrice: number,
  regularPrice: number,
): number | null {
  if (!enabled) return null;
  const basisValue = basis === "regular" ? regularPrice : costPrice;
  let raw: number;
  switch (type) {
    case "fixed":
      raw = basisValue + (fixedValue ?? 0);
      break;
    case "percentage":
      raw = basisValue * (1 + (percentage ?? 0) / 100);
      break;
    case "formula":
    default:
      raw = evaluateFormula(formula, basisValue);
      break;
  }
  let result = applyRounding(raw, roundingType, roundingCustom);
  result = Math.round(result * 100) / 100;
  return result > regularPrice ? result : null;
}

function computeCompareLegacy(rule: RuleRow, costPrice: number, regularPrice: number): number | null {
  return computeCompareAtPrice(
    rule.comparePriceBasis, rule.comparePriceEnabled, rule.comparePriceType,
    rule.comparePriceFormula, rule.comparePriceFixedValue, rule.comparePricePercentage,
    rule.compareRoundingType, rule.compareRoundingCustom, costPrice, regularPrice,
  );
}

export async function getActivePriceRules(shopDomain: string, configId?: string) {
  const where: any = { shopDomain, isActive: true };
  if (configId) where.configId = configId;
  return prisma.priceRule.findMany({ where });
}

function calcFromRule(rule: RuleRow, costPrice: number) {
  const range = findPriceRange(rule, costPrice);

  if (range) {
    let regularPrice = evaluateFormula(range.formula, costPrice);
    regularPrice = applyRounding(regularPrice, range.roundingType, range.roundingCustom ?? null);
    regularPrice = Math.round(regularPrice * 100) / 100;

    const compareAtPrice = computeCompareAtPrice(
      range.compareBasis ?? "cost", range.compareEnabled ?? false,
      range.compareType ?? "formula", range.compareFormula ?? "C",
      range.compareFixedValue ?? null, range.comparePercentage ?? null,
      range.compareRoundingType ?? "none", range.compareRoundingCustom ?? null,
      costPrice, regularPrice,
    );

    return { regularPrice, compareAtPrice, effectiveFormula: range.formula };
  }

  let regularPrice = evaluateFormula(rule.priceFormula, costPrice);
  regularPrice = applyRounding(regularPrice, rule.roundingType, rule.roundingCustom);
  regularPrice = Math.round(regularPrice * 100) / 100;

  const compareAtPrice = computeCompareLegacy(rule, costPrice, regularPrice);

  return { regularPrice, compareAtPrice, effectiveFormula: rule.priceFormula };
}

function buildResult(rule: RuleRow, costPrice: number): PriceResult {
  const { regularPrice, compareAtPrice, effectiveFormula } = calcFromRule(rule, costPrice);
  return {
    regularPrice,
    compareAtPrice,
    appliedRule: {
      id: rule.id,
      name: rule.name,
      priceFormula: effectiveFormula,
      comparePriceEnabled: rule.comparePriceEnabled,
      comparePriceBasis: rule.comparePriceBasis,
      comparePriceType: rule.comparePriceType,
      comparePriceFormula: rule.comparePriceFormula,
      comparePriceFixedValue: rule.comparePriceFixedValue,
      comparePricePercentage: rule.comparePricePercentage,
      compareRoundingType: rule.compareRoundingType,
      compareRoundingCustom: rule.compareRoundingCustom,
      roundingType: rule.roundingType,
      roundingCustom: rule.roundingCustom,
    },
  };
}

export function calculatePriceSync(
  rules: RuleRow[],
  sku: string,
  category: string,
  costPrice: number
): PriceResult {
  const rule = findRule(rules, sku, category);
  if (!rule) {
    return {
      regularPrice: Math.round(costPrice * 100) / 100,
      compareAtPrice: null,
      appliedRule: null,
    };
  }
  return buildResult(rule, costPrice);
}

export async function calculatePrices(
  shopDomain: string,
  sku: string,
  category: string,
  costPrice: number,
  configId?: string
): Promise<PriceResult> {
  const where: any = { shopDomain, isActive: true };
  if (configId) where.configId = configId;
  const rules = await prisma.priceRule.findMany({ where });
  const rule = findRule(rules, sku, category);
  if (!rule) {
    return {
      regularPrice: Math.round(costPrice * 100) / 100,
      compareAtPrice: null,
      appliedRule: null,
    };
  }
  return buildResult(rule, costPrice);
}
