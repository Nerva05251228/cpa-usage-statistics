import type { ModelPrice } from '@/utils/usage';
export type BillingConfig = { resetTimezone: string; modelPrices: Record<string, ModelPrice> };
