/**
 * Locale formatting for the pooled forecast card. Kept apart from the model so
 * the model stays free of i18n and Intl.
 */

import type { TFunction } from 'i18next';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';

/** Beyond this, a weekday alone is ambiguous, so the date is shown instead. */
const WEEKDAY_RANGE_MS = 6 * DAY_MS;

/** "Sun 4:39 PM", or "Nov 18, 4:39 PM" when more than six days from now. */
export function formatForecastInstant(ms: number, nowMs: number, locale?: string): string {
  const near = Math.abs(ms - nowMs) < WEEKDAY_RANGE_MS;
  return new Date(ms).toLocaleString(locale, {
    ...(near ? { weekday: 'short' } : { month: 'short', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Crosshair label: always weekday + time ("Sun 12:00 PM"). */
export const formatWeekdayTime = (ms: number, locale?: string): string =>
  new Date(ms).toLocaleString(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** X-axis tick: "Fri 23". */
export const formatDayTick = (ms: number, locale?: string): string =>
  new Date(ms).toLocaleDateString(locale, { weekday: 'short', day: 'numeric' });

/** Range and horizon dates: "Oct 23". */
export const formatMonthDay = (ms: number, locale?: string): string =>
  new Date(ms).toLocaleDateString(locale, { month: 'short', day: 'numeric' });

/** "2d 18h", "15h 49m", "49m" or "<1m". */
export function formatCompactDuration(t: TFunction, ms: number): string {
  if (ms < MINUTE_MS) return t('antigravity_quota.duration_less_than_minute');
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
  if (days > 0) return t('antigravity_quota.duration_day_hour', { days, hours });
  if (hours > 0) return t('antigravity_quota.duration_hour_minute', { hours, minutes });
  return t('antigravity_quota.duration_minute', { minutes });
}

export const formatPercent = (value: number): string => `${Math.round(value)}%`;

export const formatRate = (t: TFunction, value: number): string =>
  t('quota_management.pool_rate', { rate: value.toFixed(1) });
