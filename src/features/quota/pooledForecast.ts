/**
 * Pooled quota forecast: what a provider's accounts have left together, how
 * fast that is draining, and when it runs out or comes back.
 *
 * Pure and clock-free (every function takes `nowMs`), so the card is layout
 * only and every number it shows is covered by tests/pooledForecast.test.ts.
 *
 * Series are arrays of points joined by straight lines. Two consecutive points
 * with the same `t` are a vertical step (a reset), so `valueAt` distinguishes
 * the value just before an instant from the value just after it.
 */

import type { QuotaHistory, QuotaHistoryAccount } from '@/types';
import { HOUR_MS, MINUTE_MS } from '@/utils/time/durations';

export interface SeriesPoint {
  t: number;
  v: number;
}

export type ForecastView = 'remaining' | 'drain';
export const FORECAST_VIEWS: readonly ForecastView[] = ['remaining', 'drain'];

export type FutureUsage = 'same' | 'half' | 'none';
export const FUTURE_USAGE_OPTIONS: readonly FutureUsage[] = ['same', 'half', 'none'];
export const FUTURE_USAGE_FACTOR: Record<FutureUsage, number> = { same: 1, half: 0.5, none: 0 };

export type BurnWindowHours = 1 | 3 | 6;
export const BURN_WINDOW_OPTIONS: readonly BurnWindowHours[] = [1, 3, 6];
export const DEFAULT_BURN_WINDOW_HOURS: BurnWindowHours = 3;

/** Projection and drain series are sampled at least this often. */
export const FORECAST_STEP_MS = 15 * MINUTE_MS;

/** Visible span: 3 days back, 11 forward; prev/next move a week. */
export const SPAN_DAYS_BEFORE = 3;
export const SPAN_DAYS_AFTER = 11;
export const SPAN_SHIFT_DAYS = 7;

/** Fetch enough history for the default span plus the widest burn window. */
export const HISTORY_LOOKBACK_MS = SPAN_DAYS_BEFORE * 24 * HOUR_MS + 6 * HOUR_MS;

const FULL = 100;
const EPS = 1e-6;

/** Preferred card order; other providers follow alphabetically. */
const PROVIDER_ORDER = ['claude', 'codex'];

/* ---------- span and ticks ---------- */

/** Local midnights are built from calendar fields, never by adding 24h. */
const localMidnight = (ms: number, dayOffset = 0): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset).getTime();
};

export interface ForecastSpan {
  startMs: number;
  endMs: number;
}

export function forecastSpan(nowMs: number, weekOffset = 0): ForecastSpan {
  const shift = weekOffset * SPAN_SHIFT_DAYS;
  return {
    startMs: localMidnight(nowMs, shift - SPAN_DAYS_BEFORE),
    endMs: localMidnight(nowMs, shift + SPAN_DAYS_AFTER),
  };
}

/** Stats look this far ahead regardless of where the chart is scrolled. */
export const forecastHorizon = (nowMs: number): number => forecastSpan(nowMs).endMs;

/** Local midnights in [startMs, endMs). DST days are 23h or 25h long. */
export function dayTicks(startMs: number, endMs: number): number[] {
  const ticks: number[] = [];
  let day = localMidnight(startMs) < startMs ? 1 : 0;
  for (let tick = localMidnight(startMs, day); tick < endMs; tick = localMidnight(startMs, day)) {
    ticks.push(tick);
    day += 1;
  }
  return ticks;
}

/* ---------- series primitives ---------- */

/**
 * Value at `t`. `side` picks the left or right limit at a step; outside the
 * series the nearest end value holds.
 */
export function valueAt(
  points: readonly SeriesPoint[],
  t: number,
  side: 'before' | 'after' = 'after'
): number {
  if (points.length === 0) return FULL;
  if (t <= points[0].t)
    return side === 'before' || t < points[0].t ? points[0].v : lastAt(points, 0);
  const last = points[points.length - 1];
  if (t >= last.t)
    return side === 'after' || t > last.t ? last.v : firstAt(points, points.length - 1);

  // First index with points[i].t >= t.
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  if (points[lo].t === t) {
    return side === 'before' ? points[lo].v : lastAt(points, lo);
  }
  const a = points[lo - 1];
  const b = points[lo];
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

/** Value of the last point sharing points[index].t. */
const lastAt = (points: readonly SeriesPoint[], index: number): number => {
  let i = index;
  while (i + 1 < points.length && points[i + 1].t === points[index].t) i += 1;
  return points[i].v;
};

/** Value of the first point sharing points[index].t. */
const firstAt = (points: readonly SeriesPoint[], index: number): number => {
  let i = index;
  while (i > 0 && points[i - 1].t === points[index].t) i -= 1;
  return points[i].v;
};

/**
 * Reset instants in (fromMs, toMs]: `resetAtMs`, then every window after it.
 * Unknown reset → none; unknown window → only the one known instant.
 */
export function resetInstants(
  resetAtMs: number | null,
  windowMinutes: number | null,
  fromMs: number,
  toMs: number
): number[] {
  if (resetAtMs === null || toMs <= fromMs) return [];
  const windowMs = windowMinutes ? windowMinutes * MINUTE_MS : null;
  let first = resetAtMs;
  if (first <= fromMs) {
    if (!windowMs) return [];
    first += Math.floor((fromMs - first) / windowMs + 1) * windowMs;
  }
  const instants: number[] = [];
  for (let at = first; at <= toMs; at += windowMs ?? Infinity) {
    instants.push(at);
    if (!windowMs) break;
  }
  return instants;
}

/** Push without duplicating an identical trailing point. */
const pushPoint = (points: SeriesPoint[], t: number, v: number) => {
  const last = points[points.length - 1];
  if (last && last.t === t && Math.abs(last.v - v) < EPS) return;
  points.push({ t, v });
};

/* ---------- recorded ---------- */

/**
 * One account's recorded series up to `nowMs`. Linear between samples; when a
 * sample's reset passes before the next sample (or now), the value holds until
 * the reset and steps back to 100 there. Empty when the account has no samples.
 */
export function recordedAccountSeries(account: QuotaHistoryAccount, nowMs: number): SeriesPoint[] {
  const samples = account.samples.filter((sample) => sample.atMs <= nowMs);
  const points: SeriesPoint[] = [];
  samples.forEach((sample, index) => {
    pushPoint(points, sample.atMs, sample.remainingPercent);
    const nextMs = index + 1 < samples.length ? samples[index + 1].atMs : nowMs;
    const resets = resetInstants(sample.resetAtMs, account.windowMinutes, sample.atMs, nextMs);
    if (resets.length > 0) {
      pushPoint(points, resets[0], sample.remainingPercent);
      pushPoint(points, resets[0], FULL);
      // Later resets inside the same gap leave it at 100.
    }
  });
  const last = points[points.length - 1];
  if (last && last.t < nowMs) pushPoint(points, nowMs, last.v);
  return points;
}

/**
 * Remaining dropped over [fromMs, toMs], ignoring upward moves (resets), as %/h
 * of the part of the window the series actually covers. Never negative.
 * Downward steps (two samples sharing a timestamp) inside (fromMs, toMs] count.
 */
export function burnRate(points: readonly SeriesPoint[], fromMs: number, toMs: number): number {
  if (points.length < 2) return 0;
  const coveredFrom = Math.max(fromMs, points[0].t);
  const coveredTo = Math.min(toMs, points[points.length - 1].t);
  if (coveredTo <= coveredFrom) return 0;
  let drop = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (b.t === a.t) {
      if (b.v < a.v && b.t > fromMs && b.t <= coveredTo) drop += a.v - b.v;
      continue;
    }
    const lo = Math.max(a.t, coveredFrom);
    const hi = Math.min(b.t, coveredTo);
    if (hi <= lo) continue;
    const va = a.v + ((b.v - a.v) * (lo - a.t)) / (b.t - a.t);
    const vb = a.v + ((b.v - a.v) * (hi - a.t)) / (b.t - a.t);
    if (vb < va) drop += va - vb;
  }
  return Math.max(0, drop / ((coveredTo - coveredFrom) / HOUR_MS));
}

/* ---------- projection ---------- */

export interface AccountProjection {
  points: SeriesPoint[];
  /** Resets inside the projection with the value they restore from. */
  resets: { t: number; before: number }[];
  /** First instant the account reaches 0, or null. */
  emptyAt: number | null;
}

export function projectAccount(
  startValue: number,
  ratePerHour: number,
  resets: readonly number[],
  nowMs: number,
  endMs: number
): AccountProjection {
  const points: SeriesPoint[] = [{ t: nowMs, v: startValue }];
  const resetRecords: AccountProjection['resets'] = [];
  let emptyAt: number | null = startValue <= EPS ? nowMs : null;
  let anchor = nowMs;
  let anchorValue = startValue;

  const runTo = (toMs: number): number => {
    const value = anchorValue - (ratePerHour * (toMs - anchor)) / HOUR_MS;
    // Inclusive: running out exactly at a reset or at the endpoint still counts.
    if (ratePerHour > 0 && anchorValue > EPS && value <= EPS) {
      const zeroAt = Math.min(anchor + (anchorValue / ratePerHour) * HOUR_MS, toMs);
      pushPoint(points, zeroAt, 0);
      emptyAt ??= zeroAt;
      return 0;
    }
    return Math.max(0, value);
  };

  resets
    .filter((at) => at > nowMs && at <= endMs)
    .forEach((at) => {
      const before = runTo(at);
      pushPoint(points, at, before);
      pushPoint(points, at, FULL);
      resetRecords.push({ t: at, before });
      anchor = at;
      anchorValue = FULL;
    });
  pushPoint(points, endMs, runTo(endMs));
  return { points, resets: resetRecords, emptyAt };
}

/* ---------- pooling ---------- */

/** Sum of series over a set of instants, keeping steps sharp. */
function sumSeries(series: readonly SeriesPoint[][], times: readonly number[]): SeriesPoint[] {
  const sorted = [...new Set(times)].sort((a, b) => a - b);
  const points: SeriesPoint[] = [];
  sorted.forEach((t) => {
    let before = 0;
    let after = 0;
    series.forEach((points) => {
      before += valueAt(points, t, 'before');
      after += valueAt(points, t, 'after');
    });
    pushPoint(points, t, before);
    if (Math.abs(after - before) > EPS) pushPoint(points, t, after);
  });
  return points;
}

const gridTimes = (fromMs: number, toMs: number, stepMs = FORECAST_STEP_MS): number[] => {
  const times: number[] = [];
  for (let t = fromMs; t < toMs; t += stepMs) times.push(t);
  if (toMs >= fromMs) times.push(toMs);
  return times;
};

/** Keep the part of a series inside [fromMs, toMs], interpolating the ends. */
export function clipSeries(
  points: readonly SeriesPoint[],
  fromMs: number,
  toMs: number
): SeriesPoint[] {
  if (points.length === 0 || toMs < fromMs) return [];
  const first = points[0].t;
  const last = points[points.length - 1].t;
  const lo = Math.max(fromMs, first);
  const hi = Math.min(toMs, last);
  if (hi < lo) return [];
  const clipped: SeriesPoint[] = [{ t: lo, v: valueAt(points, lo, 'after') }];
  points.forEach((point) => {
    if (point.t > lo && point.t < hi) clipped.push(point);
  });
  if (hi > lo) {
    // A step exactly at the clip end keeps both sides.
    clipped.push({ t: hi, v: valueAt(points, hi, 'before') });
    if (hi === last) {
      const after = valueAt(points, hi, 'after');
      if (Math.abs(after - clipped[clipped.length - 1].v) > EPS) clipped.push({ t: hi, v: after });
    }
  }
  return clipped;
}

export interface PoolAccounts {
  provider: string;
  accounts: QuotaHistoryAccount[];
}

/** Enabled accounts grouped by provider; providers with none are dropped. */
export function groupPoolAccounts(history: QuotaHistory | null): PoolAccounts[] {
  if (!history) return [];
  const groups = new Map<string, QuotaHistoryAccount[]>();
  history.accounts.forEach((account) => {
    if (account.disabled) return;
    const list = groups.get(account.provider) ?? [];
    list.push(account);
    groups.set(account.provider, list);
  });
  const rank = (provider: string) => {
    const index = PROVIDER_ORDER.indexOf(provider);
    return index === -1 ? PROVIDER_ORDER.length : index;
  };
  return [...groups.entries()]
    .map(([provider, accounts]) => ({ provider, accounts }))
    .sort((a, b) => rank(a.provider) - rank(b.provider) || a.provider.localeCompare(b.provider));
}

export interface ResetStep {
  t: number;
  /** Pool percentage points restored at this instant. */
  restored: number;
}

export interface PoolStats {
  /** Pool reaches 0 within the horizon, else null. */
  poolEmptyAt: number | null;
  /** Soonest single account reaches 0 within the horizon, else null. */
  firstEmptyAt: number | null;
  nextReset: ResetStep | null;
  horizonMs: number;
}

export interface ProviderForecast {
  /** Enabled accounts, reporting or not. */
  accountCount: number;
  /** Enabled accounts with no samples yet; left out of every number below. */
  notReportingCount: number;
  /** Reporting accounts × 100. */
  totalPercent: number;
  remainingPercent: number;
  /** Pooled %/h over the burn window (before the future-usage factor). */
  burnPerHour: number;
  /** Clipped to the visible range. */
  recorded: SeriesPoint[];
  projected: SeriesPoint[];
  resetSteps: ResetStep[];
  drainRecorded: SeriesPoint[];
  drainProjected: SeriesPoint[];
  stats: PoolStats;
}

export interface ProviderForecastInput {
  accounts: readonly QuotaHistoryAccount[];
  nowMs: number;
  burnWindowHours: BurnWindowHours;
  futureUsage: FutureUsage;
  rangeStartMs: number;
  rangeEndMs: number;
}

const latestResetAt = (account: QuotaHistoryAccount, nowMs: number): number | null => {
  const samples = account.samples.filter((sample) => sample.atMs <= nowMs);
  return samples.length > 0 ? samples[samples.length - 1].resetAtMs : null;
};

export function buildProviderForecast(input: ProviderForecastInput): ProviderForecast {
  const { nowMs, burnWindowHours, futureUsage, rangeStartMs, rangeEndMs } = input;
  // An account with no samples has an unknown state: it is counted, never pooled.
  const accounts = input.accounts.filter((account) =>
    account.samples.some((sample) => sample.atMs <= nowMs)
  );
  const notReportingCount = input.accounts.length - accounts.length;
  const factor = FUTURE_USAGE_FACTOR[futureUsage];
  const burnWindowMs = burnWindowHours * HOUR_MS;
  const horizonMs = forecastHorizon(nowMs);
  const projectionEnd = Math.max(horizonMs, rangeEndMs);

  if (accounts.length === 0) {
    return {
      accountCount: input.accounts.length,
      notReportingCount,
      totalPercent: 0,
      remainingPercent: 0,
      burnPerHour: 0,
      recorded: [],
      projected: [],
      resetSteps: [],
      drainRecorded: [],
      drainProjected: [],
      stats: { poolEmptyAt: null, firstEmptyAt: null, nextReset: null, horizonMs },
    };
  }

  const recordedByAccount = accounts.map((account) => recordedAccountSeries(account, nowMs));

  const accountBurn = recordedByAccount.map((points) =>
    burnRate(points, nowMs - burnWindowMs, nowMs)
  );
  const burnPerHour = accountBurn.reduce((sum, rate) => sum + rate, 0);

  const projections = accounts.map((account, index) =>
    projectAccount(
      valueAt(recordedByAccount[index], nowMs, 'after'),
      accountBurn[index] * factor,
      resetInstants(latestResetAt(account, nowMs), account.windowMinutes, nowMs, projectionEnd),
      nowMs,
      projectionEnd
    )
  );

  /* recorded pool */
  const earliest = Math.min(...recordedByAccount.map((points) => points[0].t));
  const recordedFrom = Math.max(rangeStartMs, earliest);
  const recordedTo = Math.min(nowMs, rangeEndMs);
  const recordedTimes = [
    recordedFrom,
    recordedTo,
    ...recordedByAccount.flatMap((points) =>
      points.map((point) => point.t).filter((t) => t > recordedFrom && t < recordedTo)
    ),
  ];
  const recorded = recordedTo > recordedFrom ? sumSeries(recordedByAccount, recordedTimes) : [];

  /* projected pool */
  const projectedFull = sumSeries(
    projections.map((projection) => projection.points),
    [...gridTimes(nowMs, projectionEnd), ...projections.flatMap((p) => p.points.map((x) => x.t))]
  );
  const projected = clipSeries(projectedFull, rangeStartMs, rangeEndMs);

  const resetSteps: ResetStep[] = [];
  for (let i = 1; i < projected.length; i += 1) {
    const a = projected[i - 1];
    const b = projected[i];
    if (a.t === b.t && b.v > a.v + EPS) resetSteps.push({ t: b.t, restored: b.v - a.v });
  }

  /* drain */
  const drainTimes = recordedTo > recordedFrom ? gridTimes(recordedFrom, recordedTo) : [];
  const drainRecorded = drainTimes.map((t) => ({
    t,
    v: recordedByAccount.reduce((sum, points) => sum + burnRate(points, t - burnWindowMs, t), 0),
  }));
  const drainFrom = Math.max(nowMs, rangeStartMs);
  const drainProjected =
    rangeEndMs > drainFrom
      ? [
          { t: drainFrom, v: burnPerHour * factor },
          { t: rangeEndMs, v: burnPerHour * factor },
        ]
      : [];

  /* stats */
  const poolEmpty = projectedFull.find((point) => point.t <= horizonMs && point.v <= EPS);
  const firstEmptyAt = projections.reduce<number | null>(
    (soonest, projection) =>
      projection.emptyAt !== null &&
      projection.emptyAt <= horizonMs &&
      (soonest === null || projection.emptyAt < soonest)
        ? projection.emptyAt
        : soonest,
    null
  );

  let nextReset: ResetStep | null = null;
  projections.forEach((projection) => {
    const first = projection.resets[0];
    if (!first || first.t > horizonMs) return;
    const restored = FULL - first.before;
    if (nextReset === null || first.t < nextReset.t - MINUTE_MS) {
      nextReset = { t: first.t, restored };
    } else if (Math.abs(first.t - nextReset.t) < MINUTE_MS) {
      nextReset = { t: Math.min(first.t, nextReset.t), restored: nextReset.restored + restored };
    }
  });

  return {
    accountCount: input.accounts.length,
    notReportingCount,
    totalPercent: accounts.length * FULL,
    remainingPercent: recordedByAccount.reduce(
      (sum, points) => sum + valueAt(points, nowMs, 'after'),
      0
    ),
    burnPerHour,
    recorded,
    projected,
    resetSteps,
    drainRecorded,
    drainProjected,
    stats: {
      poolEmptyAt: poolEmpty ? poolEmpty.t : null,
      firstEmptyAt,
      nextReset,
      horizonMs,
    },
  };
}

/** Pool value at an instant for the crosshair: recorded up to now, projected after. */
export function forecastValueAt(
  forecast: ProviderForecast,
  view: ForecastView,
  t: number,
  nowMs: number
): { value: number; projected: boolean } | null {
  const projected = t > nowMs;
  const series =
    view === 'remaining'
      ? projected
        ? forecast.projected
        : forecast.recorded
      : projected
        ? forecast.drainProjected
        : forecast.drainRecorded;
  if (series.length === 0 || t < series[0].t || t > series[series.length - 1].t) return null;
  return { value: valueAt(series, t, 'after'), projected };
}
