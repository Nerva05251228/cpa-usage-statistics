/** The host SDK's schema v2 consists exclusively of non-overlapping buckets. */
export interface CanonicalTokenBreakdown {
  schema_version: 2;
  quality: 'complete' | 'inconsistent' | 'unclassified';
  total_tokens: number;
  input: {
    total_tokens: number;
    uncached_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
  };
  output: {
    total_tokens: number;
    non_reasoning_tokens: number;
    reasoning_tokens: number;
  };
  unclassified_tokens: number;
}

export interface TokenAccounting {
  /** Ordinary, uncached input only. */
  inputTokens: number;
  /** Ordinary output, excluding reasoning. */
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  unclassifiedTokens: number;
  totalTokens: number;
  quality: CanonicalTokenBreakdown['quality'] | 'legacy-estimate';
  estimated: boolean;
}

export interface TokenPrice {
  prompt: number;
  completion: number;
  cache: number;
  /** Optional because the original billing settings have no cache-write rate. */
  cacheWrite?: number;
}

export interface CostEstimate {
  amount: number;
  estimated: boolean;
  /** Tokens that cannot be priced, never silently charged at an arbitrary rate. */
  unpricedTokens: number;
}

const recordOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;

const countOf = (value: unknown): number => (isCount(value) ? value : 0);

function readCanonical(value: unknown): CanonicalTokenBreakdown | null {
  const raw = recordOf(value);
  const input = recordOf(raw.input);
  const output = recordOf(raw.output);
  if (
    raw.schema_version !== 2 ||
    !['complete', 'inconsistent', 'unclassified'].includes(String(raw.quality)) ||
    ![
      raw.total_tokens,
      raw.unclassified_tokens,
      input.total_tokens,
      input.uncached_tokens,
      input.cache_read_tokens,
      input.cache_write_tokens,
      output.total_tokens,
      output.non_reasoning_tokens,
      output.reasoning_tokens,
    ].every(isCount)
  ) {
    return null;
  }
  const canonical = raw as unknown as CanonicalTokenBreakdown;
  if (
    canonical.input.total_tokens !==
      canonical.input.uncached_tokens +
        canonical.input.cache_read_tokens +
        canonical.input.cache_write_tokens ||
    canonical.output.total_tokens !==
      canonical.output.non_reasoning_tokens + canonical.output.reasoning_tokens ||
    canonical.total_tokens !==
      canonical.input.total_tokens +
        canonical.output.total_tokens +
        canonical.unclassified_tokens ||
    (canonical.quality === 'complete' && canonical.unclassified_tokens !== 0)
  ) {
    return null;
  }
  return canonical;
}

function unclassified(totalTokens: number, quality: TokenAccounting['quality']): TokenAccounting {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    unclassifiedTokens: totalTokens,
    totalTokens,
    quality,
    estimated: true,
  };
}

/**
 * Prefer the validated SDK contract. Imported legacy data cannot reveal whether
 * a provider included cache/reasoning in its totals; its subset interpretation
 * is explicitly an estimate. Never add those subcategories to input/output twice.
 * The backend marks historical imports with legacy_accounting; only that flag
 * permits an estimate in place of an intentionally unclassified v2 breakdown.
 */
export function getTokenAccounting(detail: unknown): TokenAccounting {
  const raw = recordOf(detail);
  const legacyEstimate = raw.legacy_accounting === true;
  const canonical = readCanonical(raw.token_breakdown);
  if (canonical && !legacyEstimate) {
    return {
      inputTokens: canonical.input.uncached_tokens,
      outputTokens: canonical.output.non_reasoning_tokens,
      cachedTokens: canonical.input.cache_read_tokens,
      cacheWriteTokens: canonical.input.cache_write_tokens,
      reasoningTokens: canonical.output.reasoning_tokens,
      unclassifiedTokens: canonical.unclassified_tokens,
      totalTokens: canonical.total_tokens,
      quality: canonical.quality,
      estimated: canonical.quality !== 'complete',
    };
  }

  const tokens = recordOf(raw.tokens);
  const cachedTokens =
    tokens.cache_read_tokens_present === true
      ? countOf(tokens.cache_read_tokens)
      : Math.max(
          countOf(tokens.cache_read_tokens),
          countOf(tokens.cached_tokens),
          countOf(tokens.cache_tokens)
        );
  const cacheWriteTokens = Math.max(
    countOf(tokens.cache_creation_tokens),
    countOf(tokens.cache_write_tokens)
  );
  const reasoningTokens = countOf(tokens.reasoning_tokens);
  const inputTotal = Math.max(countOf(tokens.input_tokens), cachedTokens + cacheWriteTokens);
  const outputTotal = Math.max(countOf(tokens.output_tokens), reasoningTokens);
  const categoryTotal = inputTotal + outputTotal;
  const legacyTotal = countOf(tokens.total_tokens) || categoryTotal;

  if (!legacyEstimate && raw.token_breakdown !== undefined && raw.token_breakdown !== null) {
    // An invalid/future schema must not become apparently precise legacy data.
    const reported = recordOf(raw.token_breakdown).total_tokens;
    return unclassified(isCount(reported) ? reported : legacyTotal, 'inconsistent');
  }
  if (legacyTotal < categoryTotal) {
    return unclassified(legacyTotal, 'inconsistent');
  }

  return {
    inputTokens: inputTotal - cachedTokens - cacheWriteTokens,
    outputTokens: outputTotal - reasoningTokens,
    cachedTokens,
    cacheWriteTokens,
    reasoningTokens,
    unclassifiedTokens: legacyTotal - categoryTotal,
    totalTokens: legacyTotal,
    quality: 'legacy-estimate',
    estimated: true,
  };
}

/** Prices are per million tokens; output includes reasoning exactly once. */
export function priceTokenAccounting(accounting: TokenAccounting, price?: TokenPrice): CostEstimate {
  if (!price) {
    return { amount: 0, estimated: true, unpricedTokens: accounting.totalTokens };
  }
  const validRate = (rate: unknown): rate is number =>
    typeof rate === 'number' && Number.isFinite(rate) && rate >= 0;
  const prompt = validRate(price.prompt) ? price.prompt : 0;
  const completion = validRate(price.completion) ? price.completion : 0;
  const cache = validRate(price.cache) ? price.cache : 0;
  const hasWriteRate = validRate(price.cacheWrite);
  const cacheWrite = hasWriteRate ? price.cacheWrite! : prompt;
  const unpricedTokens =
    accounting.unclassifiedTokens +
    (!validRate(price.prompt) ? accounting.inputTokens : 0) +
    (!validRate(price.completion) ? accounting.outputTokens + accounting.reasoningTokens : 0) +
    (!validRate(price.cache) ? accounting.cachedTokens : 0) +
    (!hasWriteRate && !validRate(price.prompt) ? accounting.cacheWriteTokens : 0);
  const amount =
    (accounting.inputTokens * prompt +
      accounting.cachedTokens * cache +
      accounting.cacheWriteTokens * cacheWrite +
      (accounting.outputTokens + accounting.reasoningTokens) * completion) /
    1_000_000;
  return {
    amount: Number.isFinite(amount) ? amount : 0,
    estimated:
      accounting.estimated ||
      unpricedTokens > 0 ||
      (accounting.cacheWriteTokens > 0 && !hasWriteRate) ||
      !Number.isFinite(amount),
    unpricedTokens,
  };
}
