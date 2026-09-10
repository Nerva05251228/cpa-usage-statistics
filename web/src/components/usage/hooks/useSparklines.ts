import { useCallback, useMemo } from 'react';
import { calculateCost, collectUsageDetails, extractTotalTokens, type ModelPrice } from '@/utils/usage';
import type { UsagePayload } from './useUsageData';

export interface SparklineData {
  labels: string[];
  datasets: [
    {
      data: number[];
      borderColor: string;
      backgroundColor: string;
      fill: boolean;
      tension: number;
      pointRadius: number;
      borderWidth: number;
    }
  ];
}

export interface SparklineBundle {
  data: SparklineData;
}

export interface UseSparklinesOptions {
  usage: UsagePayload | null;
  loading: boolean;
  nowMs: number;
  modelPrices: Record<string, ModelPrice>;
}

export interface UseSparklinesReturn {
  requestsSparkline: SparklineBundle | null;
  tokensSparkline: SparklineBundle | null;
  rpmSparkline: SparklineBundle | null;
  tpmSparkline: SparklineBundle | null;
  costSparkline: SparklineBundle | null;
}

export interface UsageMinuteSeries {
  labels: string[];
  requests: number[];
  tokens: number[];
  costs: number[];
}

/** Shared minute buckets keep the request, token, and monetary charts aligned. */
export function buildUsageMinuteSeries(
  usage: unknown,
  nowMs: number,
  modelPrices: Record<string, ModelPrice>
): UsageMinuteSeries {
  const empty = (): UsageMinuteSeries => ({ labels: [], requests: [], tokens: [], costs: [] });
  if (!usage || !Number.isFinite(nowMs) || nowMs <= 0) return empty();
  const details = collectUsageDetails(usage);
  if (!details.length) return empty();

  const windowMinutes = 60;
  const windowStart = nowMs - windowMinutes * 60 * 1000;
  const requests = new Array<number>(windowMinutes).fill(0);
  const tokens = new Array<number>(windowMinutes).fill(0);
  const costs = new Array<number>(windowMinutes).fill(0);
  details.forEach((detail) => {
    const timestamp = detail.__timestampMs ?? 0;
    if (!Number.isFinite(timestamp) || timestamp < windowStart || timestamp > nowMs) return;
    const minuteIndex = Math.min(windowMinutes - 1, Math.floor((timestamp - windowStart) / 60000));
    requests[minuteIndex] += 1;
    tokens[minuteIndex] += extractTotalTokens(detail);
    costs[minuteIndex] += calculateCost(detail, modelPrices);
  });
  const labels = requests.map((_, idx) => {
    const date = new Date(windowStart + (idx + 1) * 60000);
    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  });
  return { labels, requests, tokens, costs };
}

export function useSparklines({ usage, loading, nowMs, modelPrices }: UseSparklinesOptions): UseSparklinesReturn {
  const lastHourSeries = useMemo(
    () => buildUsageMinuteSeries(usage, nowMs, modelPrices),
    [nowMs, usage, modelPrices]
  );

  const buildSparkline = useCallback(
    (
      series: { labels: string[]; data: number[] },
      color: string,
      backgroundColor: string
    ): SparklineBundle | null => {
      if (loading || !series?.data?.length) {
        return null;
      }
      const sliceStart = Math.max(series.data.length - 60, 0);
      const labels = series.labels.slice(sliceStart);
      const points = series.data.slice(sliceStart);
      return {
        data: {
          labels,
          datasets: [
            {
              data: points,
              borderColor: color,
              backgroundColor,
              fill: true,
              tension: 0.45,
              pointRadius: 0,
              borderWidth: 2
            }
          ]
        }
      };
    },
    [loading]
  );

  const requestsSparkline = useMemo(
    () =>
      buildSparkline(
        { labels: lastHourSeries.labels, data: lastHourSeries.requests },
        '#8b8680',
        'rgba(139, 134, 128, 0.18)'
      ),
    [buildSparkline, lastHourSeries.labels, lastHourSeries.requests]
  );

  const tokensSparkline = useMemo(
    () =>
      buildSparkline(
        { labels: lastHourSeries.labels, data: lastHourSeries.tokens },
        '#8b5cf6',
        'rgba(139, 92, 246, 0.18)'
      ),
    [buildSparkline, lastHourSeries.labels, lastHourSeries.tokens]
  );

  const rpmSparkline = useMemo(
    () =>
      buildSparkline(
        { labels: lastHourSeries.labels, data: lastHourSeries.requests },
        '#22c55e',
        'rgba(34, 197, 94, 0.18)'
      ),
    [buildSparkline, lastHourSeries.labels, lastHourSeries.requests]
  );

  const tpmSparkline = useMemo(
    () =>
      buildSparkline(
        { labels: lastHourSeries.labels, data: lastHourSeries.tokens },
        '#f97316',
        'rgba(249, 115, 22, 0.18)'
      ),
    [buildSparkline, lastHourSeries.labels, lastHourSeries.tokens]
  );

  const costSparkline = useMemo(
    () =>
      buildSparkline(
        { labels: lastHourSeries.labels, data: lastHourSeries.costs },
        '#f59e0b',
        'rgba(245, 158, 11, 0.18)'
      ),
    [buildSparkline, lastHourSeries.labels, lastHourSeries.costs]
  );

  return {
    requestsSparkline,
    tokensSparkline,
    rpmSparkline,
    tpmSparkline,
    costSparkline
  };
}
