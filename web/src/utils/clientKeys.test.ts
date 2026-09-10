import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import '../i18n';
import { ApiDetailsCard } from '../components/usage/ApiDetailsCard';
import { RequestEventsDetailsCard } from '../components/usage/RequestEventsDetailsCard';
import { clientKeyLabels, resolveClientKeyLabel } from './clientKeys';
import { getApiStats } from './usage';

const first = `key-${'1'.repeat(24)}`;
const second = `key-${'2'.repeat(24)}`;
const label = 'sk******42';
const labels = clientKeyLabels([{ id: first, label }, { id: second, label }]);
const resolveLabel = (id: string) => resolveClientKeyLabel(id, labels, '未匹配 Key');
const usage = {
  apis: Object.fromEntries([first, second].map((id, index) => [id, {
    total_requests: index + 1,
    total_tokens: 25,
    models: {
      'demo-model': {
        total_requests: index + 1,
        total_tokens: 25,
        details: [{
          timestamp: '2026-09-10T02:33:54Z',
          client_source: id,
          source: 'unknown',
          auth_index: 'unknown',
          failed: false,
          tokens: { total_tokens: 25 },
        }],
      },
    },
  }])),
};

describe('client Key labels', () => {
  it('resolves already persisted fingerprints without changing event identities', () => {
    const original = JSON.stringify(usage);
    const stats = getApiStats(usage, {}, resolveLabel);
    expect(stats.map(item => item.id)).toEqual([first, second]);
    expect(stats.map(item => item.endpoint)).toEqual([label, label]);
    expect(stats.map(item => item.totalRequests)).toEqual([1, 2]);
    expect(JSON.stringify(usage)).toBe(original);
  });

  it('does not mask an unmatched fingerprint as if it were an API Key', () => {
    expect(resolveClientKeyLabel(first, new Map(), '未匹配 Key')).toBe('未匹配 Key · 11111111');
    expect(resolveClientKeyLabel('unknown', labels, '未匹配 Key')).toBe('-');
    expect(resolveClientKeyLabel('', labels, '未匹配 Key')).toBe('-');
    expect(resolveClientKeyLabel('unexpected-raw-value', labels, '未匹配 Key')).toBe('未匹配 Key');
  });

  it('ignores malformed catalog entries', () => {
    expect(clientKeyLabels(null).size).toBe(0);
    expect(clientKeyLabels([null, {}, { id: first, label: '' }, { id: 'not-a-key-id', label }]).size).toBe(0);
  });

  it('renders actual Key masks in both API details and request client sources', () => {
    const api = renderToStaticMarkup(createElement(ApiDetailsCard, {
      apiStats: getApiStats(usage, {}, resolveLabel), loading: false, hasPrices: false,
    }));
    const events = renderToStaticMarkup(createElement(RequestEventsDetailsCard, {
      usage, loading: false, sources: [], resolveClientKey: resolveLabel,
    }));
    for (const html of [api, events]) {
      expect(html.match(/>sk\*{6}42</g)?.length).toBe(2);
      expect(html).not.toContain('ke******');
      expect(html).not.toContain(first);
      expect(html).not.toContain(second);
    }
  });
});
