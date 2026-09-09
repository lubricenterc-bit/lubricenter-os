export type BusinessArea = "STORE" | "OIL_CHANGE" | "WORKSHOP" | "ELECTROAUTO";
export type ItemType = "PRODUCT" | "SERVICE";
export type PricingMode = "STANDARD" | "CASH_USD_SPECIAL";
export type PaymentMethod =
  | "CASH_USD"
  | "CASH_VES"
  | "MOBILE_PAYMENT"
  | "TRANSFER_BDV"
  | "TRANSFER_BNC";

export interface RateSnapshot {
  bcv: number;
  operative: number;
}

export interface ProductPriceSnapshot {
  cashUsd: number;
  ves: number;
  refBcv: number;
  rates: RateSnapshot;
}

export interface WorkshopAllocationInput {
  baseRef: number;
  customerRef: number;
  cheoPercent?: number;
  cheoOverrideRef?: number | null;
  alexisBonusEnabled?: boolean;
  alexisBonusPercent?: number;
}

export interface WorkshopAllocationResult {
  customerRef: number;
  cheoRef: number;
  alexisBonusRef: number;
  lubricenterRef: number;
}

export interface ElectroautoAllocationInput {
  baseRef: number;
  customerRef: number;
  alexisPercent?: number;
  alexisOverrideRef?: number | null;
}

export interface ElectroautoAllocationResult {
  customerRef: number;
  alexisRef: number;
  lubricenterRef: number;
}
