import { apiClient } from './client';
import type { BillingConfig } from '@/types/config';
import type { ObservedSource } from '@/types/sourceInfo';
import type { ClientKeyLabel } from '@/utils/clientKeys';
export type PluginHealth = { status: string; total_requests: number; queue_depth: number; dropped_records: number; last_error?: string; retention_days: number };
export type UsageExportPayload = { version?: number; exported_at?: string; usage?: Record<string, unknown>; [key: string]: unknown };
export type UsageImportResponse = { added?: number; skipped?: number; total_requests?: number; failed_requests?: number };
export const usageApi = {
  getUsage: () => apiClient.get<Record<string, unknown>>('/usage'),
  exportUsage: () => apiClient.get<UsageExportPayload>('/usage/export'),
  importUsage: (payload: unknown) => apiClient.post<UsageImportResponse>('/usage/import', payload),
  getSources: () => apiClient.get<{ sources: ObservedSource[] }>('/sources'),
  getHealth: () => apiClient.get<PluginHealth>('/health'),
  getClientKeys: () => apiClient.get<{ keys: ClientKeyLabel[] }>('/client-keys'),
};
export const billingApi = {
  async getBilling(): Promise<BillingConfig> {
    const response = await apiClient.get<Record<string, unknown>>('/billing');
    const raw = (response.billing ?? response) as Record<string, unknown>;
    return { resetTimezone: String(raw['reset-timezone'] || 'Asia/Shanghai'), modelPrices: (raw['model-prices'] || {}) as BillingConfig['modelPrices'] };
  },
  updateBilling: (billing: BillingConfig) => apiClient.put('/billing', { 'reset-timezone': billing.resetTimezone, 'model-prices': billing.modelPrices }),
};
