import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeRequest, connectBridge, subscribeRefresh } from './bridge';

const channel = 'cpa-plugin-bridge';
const origin = 'https://cpa.example';
let listener: (event: MessageEvent) => void;
let disconnect: () => void;
let parent: { postMessage: ReturnType<typeof vi.fn> };
function receive(data: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  listener({ source: parent, origin, data: { channel, version: 1, ...data }, ...overrides } as unknown as MessageEvent);
}
function init(sessionId = 'session-1') {
  receive({ type: 'init', pluginId: 'cpa-usage-statistics', sessionId, theme: 'light', language: 'zh-CN' });
}
beforeEach(() => {
  vi.useFakeTimers();
  parent = { postMessage: vi.fn() };
  vi.stubGlobal('window', { parent, addEventListener: (_event: string, callback: typeof listener) => { listener = callback; }, removeEventListener: vi.fn() });
  disconnect = connectBridge();
});
afterEach(() => { disconnect(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('plugin bridge session and parent isolation', () => {
  it('only accepts initialization from the embedding window and correct plugin', async () => {
    receive({ type: 'init', pluginId: 'cpa-usage-statistics', sessionId: 'fake' }, { source: {} });
    await expect(bridgeRequest('GET', '/usage')).rejects.toThrow('正在连接');
    receive({ type: 'init', pluginId: 'another-plugin', sessionId: 'fake' });
    await expect(bridgeRequest('GET', '/usage')).rejects.toThrow('正在连接');
    init();
    const result = bridgeRequest('GET', '/usage');
    const request = parent.postMessage.mock.calls.at(-1)!;
    expect(request[1]).toBe(origin);
    expect(request[0]).toMatchObject({ sessionId: 'session-1', method: 'GET', path: '/usage' });
    receive({ type: 'response', sessionId: 'session-1', id: request[0].id, ok: true, data: { total: 2 } });
    await expect(result).resolves.toEqual({ total: 2 });
  });

  it('rejects pending old-session requests and ignores old responses', async () => {
    init();
    const oldRequest = bridgeRequest('GET', '/usage');
    const oldRejected = expect(oldRequest).rejects.toThrow('连接已更新');
    const oldId = parent.postMessage.mock.calls.at(-1)![0].id;
    init('session-2');
    await oldRejected;
    const fresh = bridgeRequest('GET', '/billing');
    const freshId = parent.postMessage.mock.calls.at(-1)![0].id;
    receive({ type: 'response', sessionId: 'session-1', id: oldId, ok: true, data: 'stale' });
    receive({ type: 'response', sessionId: 'session-1', id: freshId, ok: true, data: 'wrong-session' });
    receive({ type: 'response', sessionId: 'session-2', id: freshId, ok: true, data: 'wrong-origin' }, { origin: 'https://attacker.example' });
    receive({ type: 'response', sessionId: 'session-2', id: freshId, ok: true, data: 'current' });
    await expect(fresh).resolves.toBe('current');
  });

  it('keeps requests alive during theme updates but rejects them on reset', async () => {
    init();
    const request = bridgeRequest('GET', '/usage');
    const rejected = expect(request).rejects.toThrow('连接已关闭');
    init();
    receive({ type: 'reset', sessionId: 'session-1' });
    await rejected;
    await expect(bridgeRequest('GET', '/usage')).rejects.toThrow('正在连接');
  });

  it('times out requests and only processes refresh for current session', async () => {
    init();
    const refresh = vi.fn();
    const unsubscribe = subscribeRefresh(refresh);
    receive({ type: 'refresh', sessionId: 'other' });
    receive({ type: 'refresh', sessionId: 'session-1' });
    expect(refresh).toHaveBeenCalledTimes(1);
    unsubscribe();
    const pending = bridgeRequest('GET', '/usage');
    const rejected = expect(pending).rejects.toThrow('请求超时');
    await vi.advanceTimersByTimeAsync(65_000);
    await rejected;
  });
});
