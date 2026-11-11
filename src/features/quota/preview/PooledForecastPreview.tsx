/**
 * DEV-ONLY preview of the pooled quota forecast with synthetic history.
 * Registered in App.tsx only when `import.meta.env.DEV` is true:
 *   http://localhost:5173/#/__preview/quota-pool
 * Copy is intentionally not localized; this page never ships.
 */

import { useMemo, useState } from 'react';
import { useThemeStore } from '@/stores';
import type { Theme } from '@/types';
import { normalizeQuotaHistory } from '@/services/api/quotaHistory';
import { PooledForecastView } from '../components/PooledForecast';
import { buildPooledForecastFixture } from './pooledForecastFixture';
import styles from './QuotaTierPreview.module.scss';

const THEMES: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'white', label: 'White' },
  { value: 'dark', label: 'Dark' },
];

export function PooledForecastPreview() {
  const theme = useThemeStore((state) => state.theme);
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const setTheme = useThemeStore((state) => state.setTheme);
  const [nowMs] = useState(() => Date.now());
  const history = useMemo(() => normalizeQuotaHistory(buildPooledForecastFixture(nowMs)), [nowMs]);

  return (
    <div className={styles.page}>
      <header className={styles.toolbar}>
        <h1 className={styles.title}>Pooled quota forecast</h1>
        <div className={styles.segmented} role="group" aria-label="Theme">
          {THEMES.map((option) => (
            <button
              key={option.value}
              type="button"
              className={styles.segment}
              aria-pressed={theme === option.value}
              onClick={() => setTheme(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>
      <PooledForecastView history={history} nowMs={nowMs} resolvedTheme={resolvedTheme} />
    </div>
  );
}
