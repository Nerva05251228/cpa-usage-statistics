import { useEffect } from 'react';
import { subscribeRefresh } from '@/plugin/bridge';
export function useHeaderRefresh(handler: () => Promise<void>) {
  useEffect(() => subscribeRefresh(() => { void handler().catch(() => {}); }), [handler]);
}
