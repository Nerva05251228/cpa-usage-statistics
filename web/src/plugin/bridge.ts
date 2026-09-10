import { useSyncExternalStore } from 'react';

export const PLUGIN_ID = 'cpa-usage-statistics';
const CHANNEL = 'cpa-plugin-bridge';
const VERSION = 1;
export type BridgeContext = { sessionId: string; pluginId: string; theme: string; language: string };
type Pending = { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
let context: BridgeContext | null = null;
let parentOrigin: string | null = null;
let requestSequence = 0;
const pending = new Map<string, Pending>();
const subscribers = new Set<() => void>();
const refreshSubscribers = new Set<() => void>();
const notify = () => subscribers.forEach((callback) => callback());

function rejectPending(message: string) {
  pending.forEach(({ reject, timer }) => { clearTimeout(timer); reject(new Error(message)); });
  pending.clear();
}

function receive(event: MessageEvent) {
  if (window.parent === window || event.source !== window.parent) return;
  if (parentOrigin && event.origin !== parentOrigin) return;
  const value = event.data;
  if (!value || typeof value !== 'object' || value.channel !== CHANNEL || value.version !== VERSION) return;
  if (value.type === 'init') {
    if (value.pluginId !== PLUGIN_ID || typeof value.sessionId !== 'string' || !value.sessionId) return;
    parentOrigin = event.origin;
    if (context?.sessionId !== value.sessionId) rejectPending('后台连接已更新，请重试');
    context = { sessionId: value.sessionId, pluginId: PLUGIN_ID,
      theme: typeof value.theme === 'string' ? value.theme : 'light',
      language: typeof value.language === 'string' ? value.language : 'zh-CN' };
    notify();
    return;
  }
  if (!context || value.sessionId !== context.sessionId) return;
  if (value.type === 'refresh') { refreshSubscribers.forEach((callback) => callback()); return; }
  if (value.type === 'reset') { rejectPending('后台连接已关闭'); context = null; notify(); return; }
  if (value.type !== 'response' || typeof value.id !== 'string') return;
  const entry = pending.get(value.id);
  if (!entry) return;
  clearTimeout(entry.timer); pending.delete(value.id);
  if (value.ok === true) entry.resolve(value.data);
  else entry.reject(new Error(typeof value.error === 'string' ? value.error : value.error?.message || '插件请求失败'));
}

export function connectBridge(): () => void {
  window.addEventListener('message', receive);
  const ready = () => {
    if (window.parent !== window && !context) window.parent.postMessage({ channel: CHANNEL, version: VERSION, type: 'ready' }, '*');
  };
  ready();
  const timer = setInterval(ready, 1000);
  return () => {
    clearInterval(timer); window.removeEventListener('message', receive);
    rejectPending('插件页面已关闭'); context = null; parentOrigin = null; notify();
  };
}

export function useBridgeContext() {
  return useSyncExternalStore((callback) => { subscribers.add(callback); return () => { subscribers.delete(callback); }; }, () => context);
}

export function subscribeRefresh(callback: () => void) {
  refreshSubscribers.add(callback);
  return () => { refreshSubscribers.delete(callback); };
}

export function bridgeRequest<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  if (!context || !parentOrigin) return Promise.reject(new Error('正在连接 CPA 后台'));
  const id = `${context.sessionId}:${++requestSequence}`;
  const sessionId = context.sessionId;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('请求超时，请刷新后重试')); }, 65_000);
    pending.set(id, { resolve: (data) => resolve(data as T), reject, timer });
    window.parent.postMessage({ channel: CHANNEL, version: VERSION, type: 'request', sessionId, id, method, path, ...(body === undefined ? {} : { body }) }, parentOrigin!);
  });
}
