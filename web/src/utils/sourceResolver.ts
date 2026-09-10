import type { ObservedSource, CredentialInfo, SourceInfo } from '@/types/sourceInfo';
import { normalizeAuthIndex } from '@/utils/usage';
export function buildSourceInfoMap(sources: ObservedSource[]) {
  const map = new Map<string, SourceInfo>();
  for (const item of sources) {
    const value = { displayName: item.label || item.id, type: item.type || item.provider || '' };
    if (item.source) map.set(item.source, value);
    if (item.id) map.set(item.id, value);
  }
  return map;
}
export function buildAuthInfoMap(sources: ObservedSource[]) {
  const map = new Map<string, CredentialInfo>();
  for (const item of sources) {
    const key = normalizeAuthIndex(item.auth_index);
    if (key) map.set(key, { name: item.label || item.id, type: item.type || item.provider || '' });
  }
  return map;
}
export function resolveSourceDisplay(sourceRaw: string, authIndex: unknown, sourceMap: Map<string, SourceInfo>, authMap: Map<string, CredentialInfo>): SourceInfo {
  const source = sourceRaw.trim();
  const matched = sourceMap.get(source);
  if (matched) return matched;
  const auth = authMap.get(normalizeAuthIndex(authIndex) || '');
  if (auth) return { displayName: auth.name, type: auth.type };
  return { displayName: source || String(authIndex || '-'), type: '' };
}
