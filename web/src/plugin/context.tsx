import { createContext, useContext, useState, type PropsWithChildren } from 'react';
import { useTranslation } from 'react-i18next';

type Notification = { id: number; message: string; kind: 'success' | 'error' | 'info' };
const NotificationContext = createContext<(message: string, kind?: Notification['kind']) => void>(() => {});
export function NotificationProvider({ children }: PropsWithChildren) {
  const [items, setItems] = useState<Notification[]>([]);
  const { t } = useTranslation();
  const show = (message: string, kind: Notification['kind'] = 'info') => {
    setItems((previous) => [...previous.slice(-3), { id: Date.now() + Math.random(), message, kind }]);
  };
  return <NotificationContext.Provider value={show}>
    <div className="plugin-notifications" aria-live="polite">{items.map((item) => <div className={`plugin-notice ${item.kind}`} key={item.id} role={item.kind === 'error' ? 'alert' : 'status'}>
      <span>{item.message}</span><button type="button" aria-label={t('common.close')} onClick={() => setItems((previous) => previous.filter(({ id }) => id !== item.id))}>×</button>
    </div>)}</div>{children}
  </NotificationContext.Provider>;
}
export function useNotification() { return useContext(NotificationContext); }
