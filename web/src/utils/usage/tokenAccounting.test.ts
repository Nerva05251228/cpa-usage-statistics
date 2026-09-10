import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getTokenAccounting,
  priceTokenAccounting,
  type CanonicalTokenBreakdown,
} from './tokenAccounting';
import {
  buildDailyTokenBreakdown,
  buildHourlyCostSeries,
  buildHourlyTokenBreakdown,
  calculateCost,
  calculateTokenBreakdown,
  collectUsageDetails,
  collectUsageDetailsWithEndpoint,
  extractTotalTokens,
  getCostEstimate,
  type UsageDetail,
} from '../usage';
import { buildUsageMinuteSeries } from '../../components/usage/hooks/useSparklines';

const now = Date.parse('2026-09-10T08:30:00Z');
const complete = (): CanonicalTokenBreakdown => ({
  schema_version: 2,
  quality: 'complete',
  total_tokens: 150,
  input: { total_tokens: 100, uncached_tokens: 40, cache_read_tokens: 50, cache_write_tokens: 10 },
  output: { total_tokens: 50, non_reasoning_tokens: 20, reasoning_tokens: 30 },
  unclassified_tokens: 0,
});
const makeDetail = (overrides: Partial<UsageDetail> = {}): UsageDetail => ({
  timestamp: new Date(now).toISOString(),
  source: 'credential-file',
  auth_index: 1,
  failed: false,
  __modelName: 'model-a',
  // Deliberately conflicting legacy fields prove every consumer prefers v2.
  tokens: { input_tokens: 900, output_tokens: 800, reasoning_tokens: 500, cached_tokens: 400, total_tokens: 1700 },
  token_breakdown: complete(),
  ...overrides,
});
const payload = (...details: UsageDetail[]) => ({
  apis: { 'POST /v1/responses': { models: { 'model-a': { details } } } },
});
const prices = { 'model-a': { prompt: 2, completion: 10, cache: 0.5, cacheWrite: 5 } };

afterEach(() => vi.useRealTimers());

describe('canonical token accounting', () => {
  it('uses all six disjoint buckets and never adds cache/reasoning twice', () => {
    const accounting = getTokenAccounting(makeDetail());
    expect(accounting).toEqual({
      inputTokens: 40,
      outputTokens: 20,
      cachedTokens: 50,
      cacheWriteTokens: 10,
      reasoningTokens: 30,
      unclassifiedTokens: 0,
      totalTokens: 150,
      quality: 'complete',
      estimated: false,
    });
    expect(extractTotalTokens(makeDetail())).toBe(150);
  });

  it('preserves authoritative unclassified totals without assigning arbitrary costs', () => {
    const breakdown = complete();
    breakdown.total_tokens = 200;
    breakdown.unclassified_tokens = 50;
    breakdown.quality = 'unclassified';
    const detail = makeDetail({ token_breakdown: breakdown });
    expect(getTokenAccounting(detail)).toMatchObject({ totalTokens: 200, unclassifiedTokens: 50, estimated: true });
    expect(getCostEstimate(detail, prices)).toEqual({ amount: 0.000655, unpricedTokens: 50, estimated: true });
  });

  it('turns an invalid v2 partition into unclassified tokens, without falling back to conflicting raw fields', () => {
    const breakdown = complete();
    breakdown.input.uncached_tokens = 80;
    expect(getTokenAccounting(makeDetail({ token_breakdown: breakdown }))).toMatchObject({
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      totalTokens: 150,
      unclassifiedTokens: 150,
      quality: 'inconsistent',
      estimated: true,
    });
    expect(calculateCost(makeDetail({ token_breakdown: breakdown }), prices)).toBe(0);
  });

  it('does not replace a canonical zero total with legacy values', () => {
    const breakdown: CanonicalTokenBreakdown = {
      schema_version: 2,
      quality: 'complete',
      total_tokens: 0,
      input: { total_tokens: 0, uncached_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
      output: { total_tokens: 0, non_reasoning_tokens: 0, reasoning_tokens: 0 },
      unclassified_tokens: 0,
    };
    expect(extractTotalTokens(makeDetail({ token_breakdown: breakdown }))).toBe(0);
    expect(calculateCost(makeDetail({ token_breakdown: breakdown }), prices)).toBe(0);
  });

  it('treats unsupported schemas and nonfinite bucket data as unclassified', () => {
    expect(getTokenAccounting({ token_breakdown: { ...complete(), schema_version: 3 } })).toMatchObject({
      totalTokens: 150,
      unclassifiedTokens: 150,
      quality: 'inconsistent',
    });
    const breakdown = complete();
    breakdown.input.cache_read_tokens = Infinity;
    expect(getTokenAccounting({ token_breakdown: breakdown }).unclassifiedTokens).toBe(150);
  });
});

describe('legacy estimates', () => {
  it('estimates explicitly marked legacy imports while keeping live unknown v2 usage unclassified', () => {
    const detail = makeDetail({
      legacy_accounting: true,
      token_breakdown: {
        schema_version: 2,
        quality: 'unclassified',
        total_tokens: 150,
        input: { total_tokens: 0, uncached_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
        output: { total_tokens: 0, non_reasoning_tokens: 0, reasoning_tokens: 0 },
        unclassified_tokens: 150,
      },
      tokens: { input_tokens: 100, output_tokens: 50, cached_tokens: 50, reasoning_tokens: 30, total_tokens: 150 },
    });
    for (const collected of [collectUsageDetails(payload(detail)), collectUsageDetailsWithEndpoint(payload(detail))]) {
      expect(collected[0].legacy_accounting).toBe(true);
      expect(getTokenAccounting(collected[0])).toMatchObject({
        inputTokens: 50, outputTokens: 20, cachedTokens: 50, reasoningTokens: 30,
        totalTokens: 150, unclassifiedTokens: 0, quality: 'legacy-estimate', estimated: true,
      });
      expect(getCostEstimate(collected[0], prices)).toEqual({ amount: 0.000625, estimated: true, unpricedTokens: 0 });
    }
    for (const legacyFlag of [false, undefined]) {
      const live = { ...detail, legacy_accounting: legacyFlag };
      expect(getTokenAccounting(live)).toMatchObject({
        totalTokens: 150, unclassifiedTokens: 150, quality: 'unclassified', estimated: true,
      });
      expect(getCostEstimate(live, prices)).toEqual({ amount: 0, estimated: true, unpricedTokens: 150 });
    }
  });

  it('does not double count cache aliases or reasoning when total_tokens is absent', () => {
    expect(getTokenAccounting({ tokens: {
      input_tokens: 100, output_tokens: 50, reasoning_tokens: 30, cached_tokens: 40, cache_tokens: 50,
    } })).toEqual({
      inputTokens: 50, outputTokens: 20, cachedTokens: 50, cacheWriteTokens: 0,
      reasoningTokens: 30, unclassifiedTokens: 0, totalTokens: 150,
      quality: 'legacy-estimate', estimated: true,
    });
  });

  it('honors an explicitly present zero cache-read value', () => {
    expect(getTokenAccounting({ tokens: {
      input_tokens: 100, cached_tokens: 60, cache_read_tokens: 0, cache_read_tokens_present: true,
    } })).toMatchObject({ inputTokens: 100, cachedTokens: 0, totalTokens: 100, estimated: true });
  });

  it('retains a reported remainder and refuses to stack more tokens than the authoritative total', () => {
    expect(getTokenAccounting({ tokens: { input_tokens: 100, output_tokens: 50, total_tokens: 200 } }))
      .toMatchObject({ totalTokens: 200, unclassifiedTokens: 50 });
    expect(getTokenAccounting({ tokens: { input_tokens: 100, output_tokens: 50, total_tokens: 120 } }))
      .toMatchObject({ totalTokens: 120, unclassifiedTokens: 120, inputTokens: 0, quality: 'inconsistent' });
  });

  it('does not propagate negative, fractional, or nonfinite token counts', () => {
    expect(getTokenAccounting({ tokens: {
      input_tokens: -10, output_tokens: NaN, cached_tokens: Infinity, reasoning_tokens: 1.5,
    } }).totalTokens).toBe(0);
  });
});

describe('costs and aggregation', () => {
  it('prices cache reads, writes and reasoning exactly once per million', () => {
    expect(getCostEstimate(makeDetail(), prices)).toEqual({ amount: 0.000655, unpricedTokens: 0, estimated: false });
    const originalBillingPrices = { 'model-a': { prompt: 2, completion: 10, cache: 0.5 } };
    expect(getCostEstimate(makeDetail(), originalBillingPrices)).toEqual({
      amount: 0.000625, unpricedTokens: 0, estimated: true,
    });
  });

  it('distinguishes missing prices from legitimate zero rates and rejects invalid rates', () => {
    const accounting = getTokenAccounting(makeDetail());
    expect(priceTokenAccounting(accounting)).toEqual({ amount: 0, unpricedTokens: 150, estimated: true });
    expect(priceTokenAccounting(accounting, { prompt: 0, completion: 0, cache: 0, cacheWrite: 0 }))
      .toEqual({ amount: 0, unpricedTokens: 0, estimated: false });
    expect(priceTokenAccounting(accounting, { prompt: -3, completion: Infinity, cache: NaN, cacheWrite: -2 }))
      .toEqual({ amount: 0, unpricedTokens: 150, estimated: true });
  });

  it('preserves v2 through both collectors and partitions daily/hourly charts to the same total', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const usage = payload(makeDetail());
    expect(collectUsageDetails(usage)[0].token_breakdown).toEqual(complete());
    expect(collectUsageDetailsWithEndpoint(usage)[0].token_breakdown).toEqual(complete());
    expect(calculateTokenBreakdown(usage)).toEqual({ cachedTokens: 50, reasoningTokens: 30 });
    const daily = buildDailyTokenBreakdown(usage);
    const hourly = buildHourlyTokenBreakdown(usage, 1);
    for (const series of [daily, hourly]) {
      expect(Object.values(series.dataByCategory).reduce((sum, values) => sum + values[0], 0)).toBe(150);
      expect(series.dataByCategory.cacheWrite).toEqual([10]);
      expect(series.dataByCategory.output).toEqual([20]);
    }
    expect(buildHourlyCostSeries(usage, prices, 1).data).toEqual([0.000655]);
  });

  it('builds monetary sparklines, includes both window boundaries, and omits old/future requests', () => {
    const at = (offset: number) => makeDetail({ timestamp: new Date(now + offset).toISOString() });
    const usage = payload(at(-3_600_000), at(0), at(-3_600_001), at(1));
    const series = buildUsageMinuteSeries(usage, now, prices);
    expect(series.requests.reduce((a, b) => a + b, 0)).toBe(2);
    expect(series.tokens.reduce((a, b) => a + b, 0)).toBe(300);
    expect(series.costs[0]).toBe(0.000655);
    expect(series.costs[59]).toBe(0.000655);
    expect(series.costs.reduce((a, b) => a + b, 0)).toBeCloseTo(0.00131);
    expect(buildUsageMinuteSeries(usage, now, {}).costs.every((cost) => cost === 0)).toBe(true);
    expect(buildUsageMinuteSeries(usage, NaN, prices).costs).toEqual([]);
  });
});
