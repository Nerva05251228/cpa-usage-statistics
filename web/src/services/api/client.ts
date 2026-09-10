import { bridgeRequest } from '@/plugin/bridge';
export const apiClient = {
  get: <T = unknown>(path: string) => bridgeRequest<T>('GET', path),
  post: <T = unknown>(path: string, body: unknown) => bridgeRequest<T>('POST', path, body),
  put: <T = unknown>(path: string, body: unknown) => bridgeRequest<T>('PUT', path, body),
};
