import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Select } from '@/components/ui/Select';
import type { ObservedSource } from '@/types/sourceInfo';
import { buildAuthInfoMap, buildSourceInfoMap, resolveSourceDisplay } from '@/utils/sourceResolver';
import {
  collectUsageDetails,
  extractLatencyMs,
  formatDurationMs,
  LATENCY_SOURCE_FIELD,
} from '@/utils/usage';
import { getTokenAccounting } from '@/utils/usage/tokenAccounting';
import { downloadBlob } from '@/utils/download';
import styles from '@/pages/UsagePage.module.scss';

const ALL_FILTER = '__all__';
const PAGE_SIZE = 100;
const HIDDEN_COLUMNS_STORAGE_KEY = 'cpa-usage-statistics:request-events:hidden-columns';
const EVENT_COLUMNS = [
  { id: 'timestamp', label: 'usage_stats.request_events_timestamp' },
  { id: 'model', label: 'usage_stats.model_name' },
  { id: 'source', label: 'usage_stats.request_events_source' },
  { id: 'clientSource', label: 'usage_stats.request_events_client_source' },
  { id: 'authIndex', label: 'usage_stats.request_events_auth_index' },
  { id: 'result', label: 'usage_stats.request_events_result' },
  { id: 'latency', label: 'usage_stats.time' },
  { id: 'inputTokens', label: 'usage_stats.uncached_input_tokens' },
  { id: 'outputTokens', label: 'usage_stats.non_reasoning_output_tokens' },
  { id: 'reasoningTokens', label: 'usage_stats.reasoning_tokens' },
  { id: 'cachedTokens', label: 'usage_stats.cached_tokens' },
  { id: 'cacheWriteTokens', label: 'usage_stats.cache_write_tokens' },
  { id: 'unclassifiedTokens', label: 'usage_stats.unclassified_tokens' },
  { id: 'totalTokens', label: 'usage_stats.total_tokens' },
] as const;
type EventColumnId = (typeof EVENT_COLUMNS)[number]['id'];

const readHiddenColumns = (): EventColumnId[] => {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(HIDDEN_COLUMNS_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(saved)) return [];
    return EVENT_COLUMNS.filter((column) => saved.includes(column.id)).map((column) => column.id);
  } catch {
    return [];
  }
};

type RequestEventRow = {
  id: string;
  timestamp: string;
  timestampMs: number;
  timestampLabel: string;
  model: string;
  sourceRaw: string;
  source: string;
  sourceType: string;
  clientSource: string;
  clientKeyId: string;
  authIndex: string;
  failed: boolean;
  latencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  unclassifiedTokens: number;
  estimated: boolean;
  totalTokens: number;
};

export interface RequestEventsDetailsCardProps {
  usage: unknown;
  loading: boolean;
  sources: ObservedSource[];
  resolveClientKey: (id: string) => string;
}

const encodeCsv = (value: string | number): string => {
  const text = String(value ?? '');
  const trimmedLeft = text.replace(/^\s+/, '');
  const safeText = trimmedLeft && /^[=+\-@]/.test(trimmedLeft) ? `'${text}` : text;
  return `"${safeText.replace(/"/g, '""')}"`;
};

export function RequestEventsDetailsCard({
  usage,
  loading,
  sources,
  resolveClientKey,
}: RequestEventsDetailsCardProps) {
  const { t, i18n } = useTranslation();
  const latencyHint = t('usage_stats.latency_unit_hint', {
    field: LATENCY_SOURCE_FIELD,
    unit: t('usage_stats.duration_unit_ms'),
  });

  const [page, setPage] = useState(1);
  const [modelFilter, setModelFilter] = useState(ALL_FILTER);
  const [sourceFilter, setSourceFilter] = useState(ALL_FILTER);
  const [authIndexFilter, setAuthIndexFilter] = useState(ALL_FILTER);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [hiddenColumns, setHiddenColumns] = useState<EventColumnId[]>(readHiddenColumns);
  const columnsPanelId = useId();
  useEffect(() => {
    try {
      localStorage.setItem(HIDDEN_COLUMNS_STORAGE_KEY, JSON.stringify(hiddenColumns));
    } catch {
      // Column selection still works when browser storage is unavailable.
    }
  }, [hiddenColumns]);
  const authFileMap = useMemo(() => buildAuthInfoMap(sources), [sources]);
  const sourceInfoMap = useMemo(() => buildSourceInfoMap(sources), [sources]);

  const rows = useMemo<RequestEventRow[]>(() => {
    const details = collectUsageDetails(usage);

    return details
      .map((detail, index) => {
        const timestamp = detail.timestamp;
        const timestampMs =
          typeof detail.__timestampMs === 'number' && detail.__timestampMs > 0
            ? detail.__timestampMs
            : Date.parse(timestamp);
        const date = Number.isNaN(timestampMs) ? null : new Date(timestampMs);
        const sourceRaw = String(detail.source ?? '').trim();
        const authIndexRaw = detail.auth_index as unknown;
        const authIndex =
          authIndexRaw === null || authIndexRaw === undefined || authIndexRaw === ''
            ? '-'
            : String(authIndexRaw);
        const sourceInfo = resolveSourceDisplay(
          sourceRaw,
          authIndexRaw,
          sourceInfoMap,
          authFileMap
        );
        const source = sourceInfo.displayName;
        const sourceType = sourceInfo.type;
        const clientKeyId = String(detail.client_source ?? '').trim();
        const clientSource = resolveClientKey(clientKeyId);
        const model = String(detail.__modelName ?? '').trim() || '-';
        const { inputTokens, outputTokens, reasoningTokens, cachedTokens, cacheWriteTokens, unclassifiedTokens, totalTokens, estimated } = getTokenAccounting(detail);
        const latencyMs = extractLatencyMs(detail);

        return {
          id: `${timestamp}-${model}-${sourceRaw || source}-${authIndex}-${index}`,
          timestamp,
          timestampMs: Number.isNaN(timestampMs) ? 0 : timestampMs,
          timestampLabel: date ? date.toLocaleString(i18n.language) : timestamp || '-',
          model,
          sourceRaw: sourceRaw || '-',
          source,
          sourceType,
          clientSource,
          clientKeyId,
          authIndex,
          failed: detail.failed === true,
          latencyMs,
          inputTokens,
          outputTokens,
          reasoningTokens,
          cachedTokens,
          cacheWriteTokens,
          unclassifiedTokens,
          estimated,
          totalTokens,
        };
      })
      .sort((a, b) => b.timestampMs - a.timestampMs);
  }, [authFileMap, i18n.language, sourceInfoMap, usage, resolveClientKey]);

  const hasLatencyData = useMemo(() => rows.some((row) => row.latencyMs !== null), [rows]);
  const availableColumns = EVENT_COLUMNS.filter((column) => column.id !== 'latency' || hasLatencyData);
  const effectiveHiddenColumns = new Set(hiddenColumns);
  if (availableColumns.every((column) => effectiveHiddenColumns.has(column.id))) {
    effectiveHiddenColumns.delete('timestamp');
  }
  const isColumnVisible = (id: EventColumnId) =>
    !effectiveHiddenColumns.has(id) && (id !== 'latency' || hasLatencyData);
  const visibleColumnCount = availableColumns.filter((column) => isColumnVisible(column.id)).length;
  const handleColumnToggle = (id: EventColumnId) => {
    const next = new Set(effectiveHiddenColumns);
    if (next.has(id)) {
      next.delete(id);
    } else {
      if (isColumnVisible(id) && visibleColumnCount <= 1) return;
      next.add(id);
    }
    setHiddenColumns(Array.from(next));
  };

  const modelOptions = useMemo(
    () => [
      { value: ALL_FILTER, label: t('usage_stats.filter_all') },
      ...Array.from(new Set(rows.map((row) => row.model))).map((model) => ({
        value: model,
        label: model,
      })),
    ],
    [rows, t]
  );

  const sourceOptions = useMemo(
    () => [
      { value: ALL_FILTER, label: t('usage_stats.filter_all') },
      ...Array.from(new Set(rows.map((row) => row.source))).map((source) => ({
        value: source,
        label: source,
      })),
    ],
    [rows, t]
  );

  const authIndexOptions = useMemo(
    () => [
      { value: ALL_FILTER, label: t('usage_stats.filter_all') },
      ...Array.from(new Set(rows.map((row) => row.authIndex))).map((authIndex) => ({
        value: authIndex,
        label: authIndex,
      })),
    ],
    [rows, t]
  );

  const modelOptionSet = useMemo(
    () => new Set(modelOptions.map((option) => option.value)),
    [modelOptions]
  );
  const sourceOptionSet = useMemo(
    () => new Set(sourceOptions.map((option) => option.value)),
    [sourceOptions]
  );
  const authIndexOptionSet = useMemo(
    () => new Set(authIndexOptions.map((option) => option.value)),
    [authIndexOptions]
  );

  const effectiveModelFilter = modelOptionSet.has(modelFilter) ? modelFilter : ALL_FILTER;
  const effectiveSourceFilter = sourceOptionSet.has(sourceFilter) ? sourceFilter : ALL_FILTER;
  const effectiveAuthIndexFilter = authIndexOptionSet.has(authIndexFilter)
    ? authIndexFilter
    : ALL_FILTER;

  const filteredRows = useMemo(
    () =>
      rows.filter((row) => {
        const modelMatched =
          effectiveModelFilter === ALL_FILTER || row.model === effectiveModelFilter;
        const sourceMatched =
          effectiveSourceFilter === ALL_FILTER || row.source === effectiveSourceFilter;
        const authIndexMatched =
          effectiveAuthIndexFilter === ALL_FILTER || row.authIndex === effectiveAuthIndexFilter;
        return modelMatched && sourceMatched && authIndexMatched;
      }),
    [effectiveAuthIndexFilter, effectiveModelFilter, effectiveSourceFilter, rows]
  );

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  useEffect(() => { setPage(1); }, [effectiveModelFilter, effectiveSourceFilter, effectiveAuthIndexFilter]);
  const renderedRows = useMemo(() => filteredRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE), [filteredRows, currentPage]);

  const hasActiveFilters =
    effectiveModelFilter !== ALL_FILTER ||
    effectiveSourceFilter !== ALL_FILTER ||
    effectiveAuthIndexFilter !== ALL_FILTER;

  const handleClearFilters = () => {
    setModelFilter(ALL_FILTER);
    setSourceFilter(ALL_FILTER);
    setAuthIndexFilter(ALL_FILTER);
  };

  const handleExportCsv = () => {
    if (!filteredRows.length) return;

    const csvHeader = [
      'timestamp',
      'model',
      'source',
      'source_raw',
      'client_source',
      'client_key_id',
      'auth_index',
      'result',
      ...(hasLatencyData ? ['latency_ms'] : []),
      'input_tokens',
      'output_tokens',
      'reasoning_tokens',
      'cached_tokens',
      'cache_write_tokens',
      'unclassified_tokens',
      'estimated',
      'total_tokens',
    ];

    const csvRows = filteredRows.map((row) =>
      [
        row.timestamp,
        row.model,
        row.source,
        row.sourceRaw,
        row.clientSource,
        row.clientKeyId,
        row.authIndex,
        row.failed ? 'failed' : 'success',
        ...(hasLatencyData ? [row.latencyMs ?? ''] : []),
        row.inputTokens,
        row.outputTokens,
        row.reasoningTokens,
        row.cachedTokens,
        row.cacheWriteTokens,
        row.unclassifiedTokens,
        row.estimated ? 1 : 0,
        row.totalTokens,
      ]
        .map((value) => encodeCsv(value))
        .join(',')
    );

    const content = [csvHeader.join(','), ...csvRows].join('\n');
    const fileTime = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob({
      filename: `usage-events-${fileTime}.csv`,
      blob: new Blob([content], { type: 'text/csv;charset=utf-8' }),
    });
  };

  const handleExportJson = () => {
    if (!filteredRows.length) return;

    const payload = filteredRows.map((row) => ({
      timestamp: row.timestamp,
      model: row.model,
      source: row.source,
      source_raw: row.sourceRaw,
      client_source: row.clientSource,
      client_key_id: row.clientKeyId,
      auth_index: row.authIndex,
      failed: row.failed,
      estimated: row.estimated,
      ...(hasLatencyData && row.latencyMs !== null ? { latency_ms: row.latencyMs } : {}),
      tokens: {
        input_tokens: row.inputTokens,
        output_tokens: row.outputTokens,
        reasoning_tokens: row.reasoningTokens,
        cached_tokens: row.cachedTokens,
        cache_write_tokens: row.cacheWriteTokens,
        unclassified_tokens: row.unclassifiedTokens,
        total_tokens: row.totalTokens,
      },
    }));

    const content = JSON.stringify(payload, null, 2);
    const fileTime = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob({
      filename: `usage-events-${fileTime}.json`,
      blob: new Blob([content], { type: 'application/json;charset=utf-8' }),
    });
  };

  return (
    <Card
      title={t('usage_stats.request_events_title')}
      extra={
        <div className={styles.requestEventsActions}>
          <Button
            variant="secondary"
            size="sm"
            aria-expanded={columnsOpen}
            aria-controls={columnsPanelId}
            onClick={() => setColumnsOpen((open) => !open)}
          >
            {t('usage_stats.request_events_columns')} ({visibleColumnCount}/{availableColumns.length})
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClearFilters}
            disabled={!hasActiveFilters}
          >
            {t('usage_stats.clear_filters')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExportCsv}
            disabled={filteredRows.length === 0}
          >
            {t('usage_stats.export_csv')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExportJson}
            disabled={filteredRows.length === 0}
          >
            {t('usage_stats.export_json')}
          </Button>
        </div>
      }
    >
      {columnsOpen && (
        <div id={columnsPanelId} className={styles.requestEventsColumnsPanel}>
          <div className={styles.requestEventsColumnsHeader}>
            <span>{t('usage_stats.request_events_columns_hint')}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setHiddenColumns([])}
              disabled={hiddenColumns.length === 0}
            >
              {t('usage_stats.request_events_show_all_columns')}
            </Button>
          </div>
          <div className={styles.requestEventsColumnsGrid}>
            {EVENT_COLUMNS.map((column) => (
              <label key={column.id} className={styles.requestEventsColumnOption}>
                <input
                  type="checkbox"
                  checked={!effectiveHiddenColumns.has(column.id)}
                  disabled={isColumnVisible(column.id) && visibleColumnCount <= 1}
                  onChange={() => handleColumnToggle(column.id)}
                />
                <span>{t(column.label)}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      <div className={styles.requestEventsToolbar}>
        <div className={styles.requestEventsFilterItem}>
          <span className={styles.requestEventsFilterLabel}>
            {t('usage_stats.request_events_filter_model')}
          </span>
          <Select
            value={effectiveModelFilter}
            options={modelOptions}
            onChange={setModelFilter}
            className={styles.requestEventsSelect}
            ariaLabel={t('usage_stats.request_events_filter_model')}
            fullWidth={false}
          />
        </div>
        <div className={styles.requestEventsFilterItem}>
          <span className={styles.requestEventsFilterLabel}>
            {t('usage_stats.request_events_filter_source')}
          </span>
          <Select
            value={effectiveSourceFilter}
            options={sourceOptions}
            onChange={setSourceFilter}
            className={styles.requestEventsSelect}
            ariaLabel={t('usage_stats.request_events_filter_source')}
            fullWidth={false}
          />
        </div>
        <div className={styles.requestEventsFilterItem}>
          <span className={styles.requestEventsFilterLabel}>
            {t('usage_stats.request_events_filter_auth_index')}
          </span>
          <Select
            value={effectiveAuthIndexFilter}
            options={authIndexOptions}
            onChange={setAuthIndexFilter}
            className={styles.requestEventsSelect}
            ariaLabel={t('usage_stats.request_events_filter_auth_index')}
            fullWidth={false}
          />
        </div>
      </div>

      {loading && rows.length === 0 ? (
        <div className={styles.hint}>{t('common.loading')}</div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={t('usage_stats.request_events_empty_title')}
          description={t('usage_stats.request_events_empty_desc')}
        />
      ) : filteredRows.length === 0 ? (
        <EmptyState
          title={t('usage_stats.request_events_no_result_title')}
          description={t('usage_stats.request_events_no_result_desc')}
        />
      ) : (
        <>
          <div className={styles.requestEventsMeta}>
            <span>{t('usage_stats.request_events_count', { count: filteredRows.length })}</span>
            {hasLatencyData && <span className={styles.requestEventsLimitHint}>{latencyHint}</span>}
          </div>

          <div className={styles.requestEventsTableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {EVENT_COLUMNS.filter((column) => isColumnVisible(column.id)).map((column) => (
                    <th key={column.id} title={column.id === 'latency' ? latencyHint : undefined}>
                      {t(column.label)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {renderedRows.map((row) => (
                  <tr key={row.id}>
                    {isColumnVisible('timestamp') && <td title={row.timestamp} className={styles.requestEventsTimestamp}>
                      {row.timestampLabel}
                    </td>}
                    {isColumnVisible('model') && <td className={styles.modelCell}>{row.model}</td>}
                    {isColumnVisible('source') && <td className={styles.requestEventsSourceCell} title={row.source}>
                      <span>{row.source}</span>
                      {row.sourceType && (
                        <span className={styles.credentialType}>{row.sourceType}</span>
                      )}
                    </td>}
                    {isColumnVisible('clientSource') && <td className={styles.requestEventsSourceCell} title={row.clientSource}>
                      {row.clientSource}
                    </td>}
                    {isColumnVisible('authIndex') && <td className={styles.requestEventsAuthIndex} title={row.authIndex}>
                      {row.authIndex}
                    </td>}
                    {isColumnVisible('result') && <td>
                      <span
                        className={
                          row.failed
                            ? styles.requestEventsResultFailed
                            : styles.requestEventsResultSuccess
                        }
                      >
                        {row.failed ? t('stats.failure') : t('stats.success')}
                      </span>
                    </td>}
                    {isColumnVisible('latency') && (
                      <td className={styles.durationCell}>{formatDurationMs(row.latencyMs)}</td>
                    )}
                    {isColumnVisible('inputTokens') && <td>{row.inputTokens.toLocaleString()}</td>}
                    {isColumnVisible('outputTokens') && <td>{row.outputTokens.toLocaleString()}</td>}
                    {isColumnVisible('reasoningTokens') && <td>{row.reasoningTokens.toLocaleString()}</td>}
                    {isColumnVisible('cachedTokens') && <td>{row.cachedTokens.toLocaleString()}</td>}
                    {isColumnVisible('cacheWriteTokens') && <td>{row.cacheWriteTokens.toLocaleString()}</td>}
                    {isColumnVisible('unclassifiedTokens') && <td>{row.unclassifiedTokens.toLocaleString()}</td>}
                    {isColumnVisible('totalTokens') && <td title={row.estimated ? t('usage_stats.legacy_estimate') : undefined}>{row.estimated ? '≈ ' : ''}{row.totalTokens.toLocaleString()}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pageCount > 1 && <div className="plugin-pagination">
            <Button size="sm" variant="secondary" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>{t('usage_stats.previous_page')}</Button>
            <span>{currentPage} / {pageCount}</span>
            <Button size="sm" variant="secondary" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>{t('usage_stats.next_page')}</Button>
          </div>}
        </>
      )}
    </Card>
  );
}
