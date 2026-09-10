import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { collectUsageDetails, formatCompactNumber, normalizeAuthIndex } from '@/utils/usage';
import { buildAuthInfoMap, buildSourceInfoMap, resolveSourceDisplay } from '@/utils/sourceResolver';
import type { ObservedSource } from '@/types/sourceInfo';
import type { UsagePayload } from './hooks/useUsageData';
import styles from '@/pages/UsagePage.module.scss';

export interface CredentialStatsCardProps { usage: UsagePayload | null; loading: boolean; sources: ObservedSource[] }
interface CredentialRow { key: string; displayName: string; type: string; success: number; failure: number; total: number; successRate: number }
export function CredentialStatsCard({ usage, loading, sources }: CredentialStatsCardProps) {
  const { t } = useTranslation();
  const rows = useMemo(() => {
    const sourceMap = buildSourceInfoMap(sources);
    const authMap = buildAuthInfoMap(sources);
    const grouped = new Map<string, CredentialRow>();
    for (const detail of collectUsageDetails(usage)) {
      const auth = normalizeAuthIndex(detail.auth_index);
      const key = auth ? `auth:${auth}` : detail.source || 'unknown';
      const display = resolveSourceDisplay(detail.source || '', detail.auth_index, sourceMap, authMap);
      const row = grouped.get(key) || { key, displayName: display.displayName, type: display.type, success: 0, failure: 0, total: 0, successRate: 0 };
      if (detail.failed) row.failure++; else row.success++;
      row.total++; row.successRate = row.success / row.total * 100;
      grouped.set(key, row);
    }
    return [...grouped.values()].sort((a, b) => b.total - a.total);
  }, [usage, sources]);

  return (
    <Card title={t('usage_stats.credential_stats')} className={styles.detailsFixedCard}>
      {loading ? (
        <div className={styles.hint}>{t('common.loading')}</div>
      ) : rows.length > 0 ? (
        <div className={styles.detailsScroll}>
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t('usage_stats.credential_name')}</th>
                <th>{t('usage_stats.requests_count')}</th>
                <th>{t('usage_stats.success_rate')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td className={styles.modelCell}>
                    <span>{row.displayName}</span>
                    {row.type && (
                      <span className={styles.credentialType}>{row.type}</span>
                    )}
                  </td>
                  <td>
                    <span className={styles.requestCountCell}>
                      <span>{formatCompactNumber(row.total)}</span>
                      <span className={styles.requestBreakdown}>
                        (<span className={styles.statSuccess}>{row.success.toLocaleString()}</span>{' '}
                        <span className={styles.statFailure}>{row.failure.toLocaleString()}</span>)
                      </span>
                    </span>
                  </td>
                  <td>
                    <span
                      className={
                        row.successRate >= 95
                          ? styles.statSuccess
                          : row.successRate >= 80
                            ? styles.statNeutral
                            : styles.statFailure
                      }
                    >
                      {row.successRate.toFixed(1)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </div>
      ) : (
        <div className={styles.hint}>{t('usage_stats.no_data')}</div>
      )}
    </Card>
  );
}
