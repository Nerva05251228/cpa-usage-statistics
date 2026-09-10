import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import i18n from './i18n';
import { connectBridge, useBridgeContext } from './plugin/bridge';
import { NotificationProvider } from './plugin/context';
import { UsagePage } from './pages/UsagePage';
import './styles/global.scss';
function App() {
  const context = useBridgeContext();
  const { t } = useTranslation();
  useEffect(() => connectBridge(), []);
  useEffect(() => {
    if (!context) return;
    document.documentElement.dataset.theme = context.theme;
    const language = context.language.startsWith('zh') ? 'zh-CN' : context.language.startsWith('ru') ? 'ru' : 'en';
    document.documentElement.lang = language;
    void i18n.changeLanguage(language);
  }, [context]);
  if (!context) return <main className="plugin-connecting"><h1>{t('usage_stats.title')}</h1><p>{t('usage_stats.connecting')}</p></main>;
  return <main className="plugin-shell" key={context.sessionId}><NotificationProvider><UsagePage /></NotificationProvider></main>;
}
createRoot(document.getElementById('root')!).render(<App />);
