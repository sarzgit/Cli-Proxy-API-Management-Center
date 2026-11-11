/**
 * Pooled quota forecast: one card per provider showing what its enabled
 * accounts have left together, recorded and projected, with a shared toolbar.
 *
 * `PooledForecastSection` loads history; `PooledForecastView` is the pure
 * presentational part used by tests and the dev preview.
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/Select';
import { IconChevronLeft } from '@/components/ui/icons';
import { useNow } from '@/hooks/useNow';
import type { QuotaHistory, QuotaHistoryAccount, ResolvedTheme } from '@/types';
import { HOUR_MS } from '@/utils/time/durations';
import { getAuthFileIcon, getTypeLabel } from '@/features/authFiles/constants';
import {
  BURN_WINDOW_OPTIONS,
  DEFAULT_BURN_WINDOW_HOURS,
  FORECAST_VIEWS,
  FUTURE_USAGE_OPTIONS,
  HISTORY_LOOKBACK_MS,
  buildProviderForecast,
  forecastSpan,
  groupPoolAccounts,
  type BurnWindowHours,
  type ForecastSpan,
  type ForecastView,
  type FutureUsage,
} from '../pooledForecast';
import {
  formatCompactDuration,
  formatForecastInstant,
  formatMonthDay,
  formatPercent,
  formatRate,
} from '../pooledForecastFormat';
import { usePooledQuotaHistory } from '../hooks/usePooledQuotaHistory';
import { PooledForecastChart } from './PooledForecastChart';
import styles from './PooledForecast.module.scss';

/* ---------- section (data) ---------- */

export interface PooledForecastSectionProps {
  resolvedTheme: ResolvedTheme;
  /** Changes whenever the page refreshes, to refetch alongside it. */
  refreshKey: unknown;
}

/** History is refetched on this cadence while the page is open. */
const REFETCH_BUCKET_MS = 5 * 60_000;

export function PooledForecastSection({ resolvedTheme, refreshKey }: PooledForecastSectionProps) {
  const now = useNow();
  const [spanStartMs, setSpanStartMs] = useState<number | null>(null);

  // Day-aligned so minute ticks don't change the request; widened when the
  // user scrolls back past what was fetched.
  const sinceMs = useMemo(() => {
    const needed = Math.min(
      now - HISTORY_LOOKBACK_MS,
      spanStartMs === null ? Infinity : spanStartMs - 6 * HOUR_MS
    );
    const day = new Date(needed);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  }, [now, spanStartMs]);

  const refetchBucket = Math.floor(now / REFETCH_BUCKET_MS);
  const history = usePooledQuotaHistory(
    sinceMs,
    useMemo(() => [refreshKey, refetchBucket], [refreshKey, refetchBucket])
  );

  const handleSpanChange = useCallback((span: ForecastSpan) => setSpanStartMs(span.startMs), []);

  if (!history) return null;
  return (
    <PooledForecastView
      history={history}
      nowMs={now}
      resolvedTheme={resolvedTheme}
      onSpanChange={handleSpanChange}
    />
  );
}

/* ---------- view (presentational) ---------- */

export interface PooledForecastViewProps {
  history: QuotaHistory;
  nowMs: number;
  resolvedTheme: ResolvedTheme;
  onSpanChange?: (span: ForecastSpan) => void;
}

export function PooledForecastView({
  history,
  nowMs,
  resolvedTheme,
  onSpanChange,
}: PooledForecastViewProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const [view, setView] = useState<ForecastView>('remaining');
  const [burnWindow, setBurnWindow] = useState<BurnWindowHours>(DEFAULT_BURN_WINDOW_HOURS);
  const [futureUsage, setFutureUsage] = useState<FutureUsage>('same');
  const [weekOffset, setWeekOffset] = useState(0);
  const burnLabelId = useId();
  const futureLabelId = useId();

  const span = useMemo(() => forecastSpan(nowMs, weekOffset), [nowMs, weekOffset]);
  useEffect(() => {
    onSpanChange?.(span);
  }, [onSpanChange, span]);

  const groups = useMemo(() => groupPoolAccounts(history), [history]);
  const futureOptions = useMemo(
    () =>
      FUTURE_USAGE_OPTIONS.map((value) => ({
        value,
        label: t(`quota_management.pool_future_${value}`),
      })),
    [t]
  );

  if (groups.length === 0) return null;

  return (
    <section className={styles.section} aria-label={t('quota_management.pool_section_label')}>
      <div className={styles.toolbar}>
        <div
          className={styles.segmented}
          role="group"
          aria-label={t('quota_management.pool_view_label')}
        >
          {FORECAST_VIEWS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => setView(value)}
            >
              {t(`quota_management.pool_view_${value}`)}
            </button>
          ))}
        </div>

        <div className={styles.control}>
          <span className={styles.controlLabel} id={burnLabelId}>
            {t('quota_management.pool_burn_label')}
          </span>
          <div className={styles.segmented} role="group" aria-labelledby={burnLabelId}>
            {BURN_WINDOW_OPTIONS.map((hours) => (
              <button
                key={hours}
                type="button"
                aria-pressed={burnWindow === hours}
                onClick={() => setBurnWindow(hours)}
              >
                {t('quota_management.pool_hours', { hours })}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.control}>
          <span className={styles.controlLabel} id={futureLabelId}>
            {t('quota_management.pool_future_label')}
          </span>
          <Select
            value={futureUsage}
            options={futureOptions}
            onChange={(value) => setFutureUsage(value as FutureUsage)}
            ariaLabelledBy={futureLabelId}
            size="sm"
          />
        </div>

        <div className={styles.range}>
          <span className={styles.rangeLabel}>
            {t('quota_management.pool_range', {
              start: formatMonthDay(span.startMs, locale),
              end: formatMonthDay(span.endMs - 1, locale),
            })}
          </span>
          <div className={styles.rangeNav}>
            <button
              type="button"
              className={styles.iconButton}
              aria-label={t('quota_management.windows_prev')}
              onClick={() => setWeekOffset((value) => value - 1)}
            >
              <IconChevronLeft size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={styles.iconButton}
              aria-label={t('quota_management.windows_next')}
              onClick={() => setWeekOffset((value) => value + 1)}
            >
              <IconChevronLeft size={15} aria-hidden="true" className={styles.flip} />
            </button>
            <button
              type="button"
              className={styles.todayButton}
              disabled={weekOffset === 0}
              onClick={() => setWeekOffset(0)}
            >
              {t('quota_management.windows_today')}
            </button>
          </div>
        </div>
      </div>

      {groups.map((group) => (
        <PooledForecastCard
          key={group.provider}
          provider={group.provider}
          accounts={group.accounts}
          nowMs={nowMs}
          span={span}
          view={view}
          burnWindow={burnWindow}
          futureUsage={futureUsage}
          resolvedTheme={resolvedTheme}
        />
      ))}
    </section>
  );
}

/* ---------- card ---------- */

interface PooledForecastCardProps {
  provider: string;
  accounts: QuotaHistoryAccount[];
  nowMs: number;
  span: ForecastSpan;
  view: ForecastView;
  burnWindow: BurnWindowHours;
  futureUsage: FutureUsage;
  resolvedTheme: ResolvedTheme;
}

function PooledForecastCard({
  provider,
  accounts,
  nowMs,
  span,
  view,
  burnWindow,
  futureUsage,
  resolvedTheme,
}: PooledForecastCardProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const forecast = useMemo(
    () =>
      buildProviderForecast({
        accounts,
        nowMs,
        burnWindowHours: burnWindow,
        futureUsage,
        rangeStartMs: span.startMs,
        rangeEndMs: span.endMs,
      }),
    [accounts, nowMs, burnWindow, futureUsage, span]
  );

  const label = getTypeLabel(t, provider);
  const icon = getAuthFileIcon(provider, resolvedTheme);
  const accentKey = provider.replace(/[^a-z0-9-]/g, '');
  const { poolEmptyAt, firstEmptyAt, nextReset, horizonMs } = forecast.stats;
  const dash = '—';

  const stats = [
    {
      key: 'pool_empty',
      label: t('quota_management.pool_stat_pool_empty'),
      value:
        poolEmptyAt !== null
          ? formatForecastInstant(poolEmptyAt, nowMs, locale)
          : t('quota_management.pool_not_by', { date: formatMonthDay(horizonMs - 1, locale) }),
    },
    {
      key: 'first_empty',
      label: t('quota_management.pool_stat_first_empty'),
      value:
        firstEmptyAt === null
          ? dash
          : firstEmptyAt <= nowMs
            ? t('quota_management.pool_now')
            : t('quota_management.pool_in', {
                duration: formatCompactDuration(t, firstEmptyAt - nowMs),
              }),
    },
    {
      key: 'next_reset',
      label: t('quota_management.pool_stat_next_reset'),
      value: nextReset ? (
        <>
          <span className={styles.statAccent}>+{formatPercent(nextReset.restored)}</span>{' '}
          {formatForecastInstant(nextReset.t, nowMs, locale)}
        </>
      ) : (
        dash
      ),
    },
    {
      key: 'burn',
      label: t('quota_management.pool_stat_burn', { hours: burnWindow }),
      value: formatRate(t, forecast.burnPerHour),
    },
  ];

  return (
    <article
      className={styles.card}
      style={
        { '--pool-accent': `var(--pool-${accentKey}, var(--text-secondary))` } as CSSProperties
      }
    >
      <header className={styles.cardHead}>
        {icon && <img className={styles.icon} src={icon} alt="" width={20} height={20} />}
        <h2 className={styles.provider}>{label}</h2>
        <span className={styles.accounts}>
          {t('quota_management.pool_accounts', { count: forecast.accountCount })}
        </span>
      </header>

      <div className={styles.summary}>
        <p className={styles.total}>
          <span className={styles.totalValue}>{formatPercent(forecast.remainingPercent)}</span>
          <span className={styles.totalOf}>
            {t('quota_management.pool_of_total', { total: formatPercent(forecast.totalPercent) })}
          </span>
        </p>
        <dl className={styles.stats}>
          {stats.map((stat) => (
            <div key={stat.key} className={styles.stat}>
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <PooledForecastChart
        forecast={forecast}
        view={view}
        span={span}
        nowMs={nowMs}
        label={label}
      />

      <footer className={styles.legend}>
        <span className={styles.legendItem}>
          <span className={styles.legendPool} aria-hidden="true" />
          {t('quota_management.pool_legend_pool')}
        </span>
        <span className={styles.legendItem}>
          <span className={styles.legendRecorded} aria-hidden="true" />
          {t('quota_management.pool_legend_recorded')}
        </span>
        <span className={styles.legendItem}>
          <span className={styles.legendProjected} aria-hidden="true" />
          {t('quota_management.pool_legend_projected')}
        </span>
      </footer>
    </article>
  );
}
