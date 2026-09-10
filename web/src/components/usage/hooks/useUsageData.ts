import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { billingApi, usageApi, type PluginHealth } from '@/services/api';
import type { BillingConfig } from '@/types/config';
import type { ObservedSource } from '@/types/sourceInfo';
import type { ModelPrice } from '@/utils/usage';
import type { ClientKeyLabel } from '@/utils/clientKeys';
import { downloadBlob } from '@/utils/download';
import { useNotification } from '@/plugin/context';

export interface UsagePayload {
  total_requests?: number; success_count?: number; failure_count?: number; total_tokens?: number;
  apis?: Record<string, unknown>; [key: string]: unknown;
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
export function useUsageData() {
  const { t } = useTranslation();
  const notify = useNotification();
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [sources, setSources] = useState<ObservedSource[]>([]);
  const [clientKeys, setClientKeys] = useState<ClientKeyLabel[]>([]);
  const [health, setHealth] = useState<PluginHealth | null>(null);
  const [billing, setBilling] = useState<BillingConfig>({ resetTimezone: 'Asia/Shanghai', modelPrices: {} });
  const [billingLoaded, setBillingLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [savingTimezone, setSavingTimezone] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef<Promise<void> | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const loadUsage = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    setLoading(true); setError('');
    const work = (async () => {
      const results = await Promise.allSettled([usageApi.getUsage(), billingApi.getBilling(), usageApi.getSources(), usageApi.getHealth(), usageApi.getClientKeys()]);
      if (!mounted.current) return;
      const [usageResult, billingResult, sourcesResult, healthResult, clientKeysResult] = results;
      const errors: string[] = [];
      if (usageResult.status === 'fulfilled') {
        const raw = usageResult.value.usage ?? usageResult.value;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) errors.push('统计数据格式无效');
        else { setUsage(raw as UsagePayload); setLastRefreshedAt(new Date()); }
      } else errors.push(messageOf(usageResult.reason));
      if (billingResult.status === 'fulfilled') { setBilling(billingResult.value); setBillingLoaded(true); }
      else errors.push(`价格设置：${messageOf(billingResult.reason)}`);
      if (sourcesResult.status === 'fulfilled') setSources(sourcesResult.value.sources || []);
      else errors.push(`凭据名称：${messageOf(sourcesResult.reason)}`);
      if (healthResult.status === 'fulfilled') setHealth(healthResult.value);
      else errors.push(`采集状态：${messageOf(healthResult.reason)}`);
      if (clientKeysResult.status === 'fulfilled') setClientKeys(clientKeysResult.value.keys || []);
      else {
        setClientKeys([]);
        errors.push(t('usage_stats.client_keys_unavailable'));
      }
      setError(errors.join('；')); setLoading(false);
    })().finally(() => { inFlight.current = null; });
    inFlight.current = work;
    return work;
  }, [t]);
  useEffect(() => { void loadUsage(); }, [loadUsage]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const data = await usageApi.exportUsage();
      downloadBlob({ filename: `cpa-usage-export-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, blob: new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }) });
      notify(t('usage_stats.export_success'), 'success');
    } catch (error) { notify(`${t('notification.download_failed')}: ${messageOf(error)}`, 'error'); }
    finally { if (mounted.current) setExporting(false); }
  };
  const handleImportChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setImporting(true);
    try {
      if (file.size > 32 * 1024 * 1024) throw new Error('导入文件不能超过 32 MB');
      let payload: unknown;
      try { payload = JSON.parse(await file.text()); } catch { throw new Error(t('usage_stats.import_invalid')); }
      const result = await usageApi.importUsage(payload);
      notify(t('usage_stats.import_success', { added: result.added ?? 0, skipped: result.skipped ?? 0, total: result.total_requests ?? 0, failed: result.failed_requests ?? 0 }), 'success');
      await loadUsage();
    } catch (error) { notify(`${t('notification.upload_failed')}: ${messageOf(error)}`, 'error'); }
    finally { if (mounted.current) setImporting(false); }
  };
  const saveBilling = async (next: BillingConfig) => {
    if (!billingLoaded) throw new Error('价格设置尚未加载，请刷新后重试');
    try { await billingApi.updateBilling(next); if (mounted.current) setBilling(next); }
    catch (error) { notify(`${t('notification.save_failed')}: ${messageOf(error)}`, 'error'); throw error; }
  };
  const setModelPrices = async (modelPrices: Record<string, ModelPrice>) => saveBilling({ ...billing, modelPrices });
  const setResetTimezone = async (resetTimezone: string) => {
    setSavingTimezone(true);
    try { await saveBilling({ ...billing, resetTimezone }); notify(t('usage_stats.timezone_saved'), 'success'); }
    finally { if (mounted.current) setSavingTimezone(false); }
  };
  return { usage, sources, clientKeys, health, loading, error, lastRefreshedAt, modelPrices: billing.modelPrices,
    resetTimezone: billing.resetTimezone, billingLoaded, savingTimezone, setResetTimezone,
    setModelPrices, loadUsage, handleExport, handleImport: () => importInputRef.current?.click(), handleImportChange, importInputRef, exporting, importing };
}

export type UseUsageDataReturn = ReturnType<typeof useUsageData>;
