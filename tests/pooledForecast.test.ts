import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import {
  buildProviderForecast,
  burnRate,
  clipSeries,
  dayTicks,
  forecastSpan,
  forecastValueAt,
  groupPoolAccounts,
  projectAccount,
  recordedAccountSeries,
  resetInstants,
  valueAt,
  type ProviderForecastInput,
} from '../src/features/quota/pooledForecast';
import { apiClient } from '../src/services/api/client';
import { normalizeQuotaHistory, quotaHistoryApi } from '../src/services/api/quotaHistory';
import type { QuotaHistoryAccount, QuotaHistorySample } from '../src/types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK_MINUTES = 7 * 24 * 60;

// Fixed local clock: Tue Nov 10 2026, 12:00.
const NOW = new Date(2026, 10, 10, 12).getTime();

const sample = (atMs: number, remainingPercent: number, resetAtMs: number | null = null) =>
  ({ atMs, remainingPercent, resetAtMs }) satisfies QuotaHistorySample;

const account = (
  authId: string,
  samples: QuotaHistorySample[],
  extra: Partial<QuotaHistoryAccount> = {}
): QuotaHistoryAccount => ({
  authId,
  provider: 'claude',
  label: authId,
  fileName: authId,
  disabled: false,
  windowMinutes: WEEK_MINUTES,
  samples,
  ...extra,
});

const forecastFor = (
  accounts: QuotaHistoryAccount[],
  overrides: Partial<ProviderForecastInput> = {}
) => {
  const span = forecastSpan(NOW);
  return buildProviderForecast({
    accounts,
    nowMs: NOW,
    burnWindowHours: 3,
    futureUsage: 'same',
    rangeStartMs: span.startMs,
    rangeEndMs: span.endMs,
    ...overrides,
  });
};

describe('series primitives', () => {
  test('valueAt interpolates and separates the two sides of a step', () => {
    const points = [
      { t: 0, v: 40 },
      { t: 10, v: 20 },
      { t: 10, v: 100 },
      { t: 20, v: 90 },
    ];
    expect(valueAt(points, -5)).toBe(40);
    expect(valueAt(points, 5)).toBe(30);
    expect(valueAt(points, 10, 'before')).toBe(20);
    expect(valueAt(points, 10, 'after')).toBe(100);
    expect(valueAt(points, 15)).toBe(95);
    expect(valueAt(points, 99)).toBe(90);
    expect(valueAt([], 5)).toBe(100);
  });

  test('resetInstants recurs every window and stops without one', () => {
    expect(resetInstants(100, 1, 0, 250_000)).toEqual([100, 60_100, 120_100, 180_100, 240_100]);
    // A reset already passed rolls forward to the first one after `from`.
    expect(resetInstants(100, 1, 60_100, 130_000)).toEqual([120_100]);
    expect(resetInstants(500, null, 0, 1000)).toEqual([500]);
    expect(resetInstants(500, null, 600, 1000)).toEqual([]);
    expect(resetInstants(null, 1, 0, 1000)).toEqual([]);
  });

  test('clipSeries interpolates the ends and keeps inner steps', () => {
    const points = [
      { t: 0, v: 100 },
      { t: 10, v: 0 },
      { t: 10, v: 100 },
      { t: 20, v: 50 },
    ];
    expect(clipSeries(points, 5, 15)).toEqual([
      { t: 5, v: 50 },
      { t: 10, v: 0 },
      { t: 10, v: 100 },
      { t: 15, v: 75 },
    ]);
    expect(clipSeries(points, 30, 40)).toEqual([]);
  });
});

describe('recorded series', () => {
  test('steps back to 100 when a reset passes between samples', () => {
    const resetAt = NOW - 6 * HOUR;
    const points = recordedAccountSeries(
      account('a', [sample(NOW - 10 * HOUR, 40, resetAt), sample(NOW - 2 * HOUR, 90, NOW + DAY)]),
      NOW
    );
    expect(valueAt(points, NOW - 8 * HOUR)).toBe(40); // holds until the reset
    expect(valueAt(points, resetAt, 'before')).toBe(40);
    expect(valueAt(points, resetAt, 'after')).toBe(100);
    expect(valueAt(points, NOW - 4 * HOUR)).toBe(95);
    expect(valueAt(points, NOW)).toBe(90);
    expect(points[points.length - 1]).toEqual({ t: NOW, v: 90 });
  });

  test('applies a reset between the last sample and now', () => {
    const points = recordedAccountSeries(
      account('a', [sample(NOW - 5 * HOUR, 12, NOW - HOUR)]),
      NOW
    );
    expect(valueAt(points, NOW - HOUR, 'before')).toBe(12);
    expect(valueAt(points, NOW)).toBe(100);
  });

  test('ignores samples after now', () => {
    const points = recordedAccountSeries(
      account('a', [sample(NOW - HOUR, 50), sample(NOW + HOUR, 10)]),
      NOW
    );
    expect(valueAt(points, NOW)).toBe(50);
  });
});

describe('burn rate', () => {
  test('drop over the window in %/h', () => {
    const points = [
      { t: NOW - 3 * HOUR, v: 50 },
      { t: NOW, v: 44 },
    ];
    expect(burnRate(points, NOW - 3 * HOUR, NOW)).toBeCloseTo(2, 6);
    expect(burnRate(points, NOW - HOUR, NOW)).toBeCloseTo(2, 6);
  });

  test('ignores reset jumps', () => {
    const points = recordedAccountSeries(
      account('a', [
        sample(NOW - 3 * HOUR, 10, NOW - 2 * HOUR),
        sample(NOW - HOUR, 98, NOW + DAY),
        sample(NOW, 96, NOW + DAY),
      ]),
      NOW
    );
    // Flat 10 → reset → 100 to 98 to 96: 4 points dropped over 3 hours.
    expect(burnRate(points, NOW - 3 * HOUR, NOW)).toBeCloseTo(4 / 3, 6);
  });

  test('is never negative', () => {
    const points = [
      { t: NOW - 3 * HOUR, v: 20 },
      { t: NOW, v: 60 },
    ];
    expect(burnRate(points, NOW - 3 * HOUR, NOW)).toBe(0);
  });

  test('uses only the covered part of the window', () => {
    const points = [
      { t: NOW - HOUR, v: 50 },
      { t: NOW, v: 47 },
    ];
    expect(burnRate(points, NOW - 3 * HOUR, NOW)).toBeCloseTo(3, 6);
    expect(burnRate([{ t: NOW, v: 50 }], NOW - HOUR, NOW)).toBe(0);
  });
});

describe('projection', () => {
  test('decreases to 0, then jumps to 100 at each reset', () => {
    const projection = projectAccount(10, 5, [NOW + 10 * HOUR, NOW + 20 * HOUR], NOW, NOW + DAY);
    expect(projection.emptyAt).toBe(NOW + 2 * HOUR);
    expect(valueAt(projection.points, NOW + HOUR)).toBe(5);
    expect(valueAt(projection.points, NOW + 5 * HOUR)).toBe(0);
    expect(valueAt(projection.points, NOW + 10 * HOUR, 'before')).toBe(0);
    expect(valueAt(projection.points, NOW + 10 * HOUR, 'after')).toBe(100);
    expect(valueAt(projection.points, NOW + 20 * HOUR, 'before')).toBe(50);
    expect(projection.resets).toEqual([
      { t: NOW + 10 * HOUR, before: 0 },
      { t: NOW + 20 * HOUR, before: 50 },
    ]);
  });

  test('unknown reset means no jumps', () => {
    const forecast = forecastFor([
      account('a', [sample(NOW - 3 * HOUR, 60), sample(NOW, 54)], { windowMinutes: null }),
    ]);
    expect(forecast.resetSteps).toEqual([]);
    expect(forecast.stats.nextReset).toBeNull();
    // 2%/h from 54 → empty in 27h.
    expect(forecast.stats.firstEmptyAt).toBe(NOW + 27 * HOUR);
    expect(forecast.stats.poolEmptyAt).toBe(NOW + 27 * HOUR);
  });

  test('zero burn keeps the pool flat', () => {
    const forecast = forecastFor([account('a', [sample(NOW - 4 * HOUR, 70), sample(NOW, 70)])]);
    expect(forecast.burnPerHour).toBe(0);
    expect(forecast.stats.poolEmptyAt).toBeNull();
    expect(forecast.stats.firstEmptyAt).toBeNull();
    expect(forecast.projected.every((point) => point.v === 70)).toBe(true);
  });

  test('future usage factors scale the projected burn', () => {
    const accounts = [
      account('a', [sample(NOW - 3 * HOUR, 60), sample(NOW, 54)], { windowMinutes: null }),
    ];
    expect(forecastFor(accounts, { futureUsage: 'half' }).stats.firstEmptyAt).toBe(NOW + 54 * HOUR);
    const none = forecastFor(accounts, { futureUsage: 'none' });
    expect(none.stats.firstEmptyAt).toBeNull();
    expect(none.projected.every((point) => point.v === 54)).toBe(true);
    // The burn stat itself is the observed rate, independent of the factor.
    expect(none.burnPerHour).toBeCloseTo(2, 6);
    expect(none.drainProjected.every((point) => point.v === 0)).toBe(true);
  });

  test('projection is sampled at least every 15 minutes', () => {
    const forecast = forecastFor([account('a', [sample(NOW - 3 * HOUR, 60), sample(NOW, 54)])]);
    for (let i = 1; i < forecast.projected.length; i += 1) {
      expect(forecast.projected[i].t - forecast.projected[i - 1].t).toBeLessThanOrEqual(15 * MIN);
    }
  });
});

describe('pool stats', () => {
  const resetA = NOW + 22 * HOUR; // Wed 10:00
  const accounts = [
    // 4%/h from 20 → empty in 5h, resets in 22h.
    account('a', [sample(NOW - 3 * HOUR, 32, resetA), sample(NOW, 20, resetA)]),
    // 1%/h from 50, resets in 3 days.
    account('b', [sample(NOW - 3 * HOUR, 53, NOW + 3 * DAY), sample(NOW, 50, NOW + 3 * DAY)]),
    // No samples: unknown and excluded from the pool.
    account('c', []),
  ];

  test('headline numbers', () => {
    const forecast = forecastFor(accounts);
    expect(forecast.accountCount).toBe(3);
    expect(forecast.totalPercent).toBe(200);
    expect(forecast.notReportingCount).toBe(1);
    expect(forecast.remainingPercent).toBe(70);
    expect(forecast.burnPerHour).toBeCloseTo(5, 6);
  });

  test('first empty, next reset and pool empty', () => {
    const forecast = forecastFor(accounts);
    expect(forecast.stats.firstEmptyAt).toBe(NOW + 5 * HOUR);
    // Account a is at 0 when it resets, so the reset restores a full 100.
    expect(forecast.stats.nextReset).toEqual({ t: resetA, restored: 100 });
    // Account a empties again after its reset; b empties after 50 hours.
    expect(forecast.stats.poolEmptyAt).toBe(NOW + 50 * HOUR);
    expect(forecast.resetSteps[0]).toEqual({ t: resetA, restored: 100 });
  });

  test('next reset restores only what was used', () => {
    const forecast = forecastFor([
      account('a', [sample(NOW - 3 * HOUR, 80, NOW + 10 * HOUR), sample(NOW, 77, NOW + 10 * HOUR)]),
    ]);
    // 1%/h: 77 → 67 at the reset.
    expect(forecast.stats.nextReset?.t).toBe(NOW + 10 * HOUR);
    expect(forecast.stats.nextReset?.restored).toBeCloseTo(33, 6);
  });

  test('accounts resetting together are summed', () => {
    const at = NOW + 10 * HOUR;
    const forecast = forecastFor([
      account('a', [sample(NOW, 60, at)]),
      account('b', [sample(NOW, 70, at)]),
    ]);
    expect(forecast.stats.nextReset).toEqual({ t: at, restored: 70 });
  });

  test('pool empty is when the last account runs out', () => {
    const forecast = forecastFor(
      [
        account('a', [sample(NOW - HOUR, 12), sample(NOW, 10)]),
        account('b', [sample(NOW - HOUR, 21), sample(NOW, 20)]),
      ],
      { burnWindowHours: 1 }
    );
    expect(forecast.stats.firstEmptyAt).toBe(NOW + 5 * HOUR);
    expect(forecast.stats.poolEmptyAt).toBe(NOW + 20 * HOUR);
  });

  test('an already-empty account is empty now', () => {
    const forecast = forecastFor([account('a', [sample(NOW, 0, NOW + DAY)])]);
    expect(forecast.stats.firstEmptyAt).toBe(NOW);
    expect(forecast.stats.poolEmptyAt).toBe(NOW);
  });

  test('crosshair reads recorded before now and projected after', () => {
    const forecast = forecastFor(accounts);
    expect(forecastValueAt(forecast, 'remaining', NOW - HOUR, NOW)).toEqual({
      value: 75,
      projected: false,
    });
    const later = forecastValueAt(forecast, 'remaining', NOW + HOUR, NOW);
    expect(later?.projected).toBe(true);
    expect(later?.value).toBeCloseTo(65, 6);
  });
});

describe('grouping', () => {
  test('excludes disabled accounts and orders providers', () => {
    const groups = groupPoolAccounts({
      generatedAtMs: NOW,
      accounts: [
        account('k', [], { provider: 'kimi' }),
        account('x', [], { provider: 'codex' }),
        account('c1', []),
        account('c2', [], { disabled: true }),
        account('d', [], { provider: 'devin', disabled: true }),
      ],
    });
    expect(groups.map((group) => [group.provider, group.accounts.length])).toEqual([
      ['claude', 1],
      ['codex', 1],
      ['kimi', 1],
    ]);
    expect(groupPoolAccounts(null)).toEqual([]);
  });
});

describe('span and ticks', () => {
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/New_York';
  });
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  test('day ticks stay on local midnight across a DST change', () => {
    // US DST ends Sun Nov 1 2026; this span crosses it.
    const now = new Date(2026, 9, 30, 15).getTime();
    const span = forecastSpan(now);
    expect(new Date(span.startMs).getDate()).toBe(27);
    expect(new Date(span.endMs).getDate()).toBe(10);
    const ticks = dayTicks(span.startMs, span.endMs);
    expect(ticks).toHaveLength(14);
    ticks.forEach((tick) => {
      const date = new Date(tick);
      expect(date.getHours()).toBe(0);
      expect(date.getMinutes()).toBe(0);
    });
    const gaps = ticks.slice(1).map((tick, index) => tick - ticks[index]);
    expect(gaps.filter((gap) => gap === 25 * HOUR)).toHaveLength(1);
    expect(gaps.filter((gap) => gap === DAY)).toHaveLength(12);
  });

  test('ticks start at the first midnight inside the range', () => {
    const start = new Date(2026, 10, 3, 9).getTime();
    const end = new Date(2026, 10, 6, 0).getTime();
    expect(dayTicks(start, end).map((tick) => new Date(tick).getDate())).toEqual([4, 5]);
  });

  test('prev/next shift the span by a week', () => {
    const now = new Date(2026, 10, 10, 12).getTime();
    expect(new Date(forecastSpan(now, -1).startMs).getDate()).toBe(31);
    expect(new Date(forecastSpan(now, 1).startMs).getDate()).toBe(14);
  });
});

describe('normalizeQuotaHistory', () => {
  test('maps snake_case seconds to camelCase milliseconds', () => {
    const history = normalizeQuotaHistory({
      generated_at: 1794400000,
      accounts: [
        {
          auth_id: 'claude-a.json',
          provider: 'Claude',
          label: 'user@example.com',
          file_name: 'claude-a.json',
          disabled: false,
          window_minutes: 10080,
          samples: [
            { t: 1794390000, remaining_percent: 48, reset_at: 1794500000 },
            { t: 1794380000, remaining_percent: 140, reset_at: 0 },
            { t: 'bad', remaining_percent: 10 },
          ],
        },
        { provider: 'codex' },
        'junk',
      ],
    });
    expect(history.generatedAtMs).toBe(1794400000000);
    expect(history.accounts).toEqual([
      {
        authId: 'claude-a.json',
        provider: 'claude',
        label: 'user@example.com',
        fileName: 'claude-a.json',
        disabled: false,
        windowMinutes: 10080,
        samples: [
          { atMs: 1794380000000, remainingPercent: 100, resetAtMs: null },
          { atMs: 1794390000000, remainingPercent: 48, resetAtMs: 1794500000000 },
        ],
      },
    ]);
    expect(normalizeQuotaHistory(null)).toEqual({ generatedAtMs: null, accounts: [] });
  });
});

describe('quotaHistoryApi', () => {
  test('requests unix seconds and resolves null on 404', async () => {
    const get = spyOn(apiClient, 'get');
    get.mockResolvedValueOnce({ generated_at: 10, accounts: [] });
    expect(await quotaHistoryApi.fetch(1_794_390_000_500)).toEqual({
      generatedAtMs: 10_000,
      accounts: [],
    });
    expect(get.mock.calls[0]).toEqual(['/quota/history', { params: { since: 1794390000 } }]);

    get.mockRejectedValueOnce(Object.assign(new Error('404 page not found'), { status: 404 }));
    expect(await quotaHistoryApi.fetch(0)).toBeNull();

    get.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    await expect(quotaHistoryApi.fetch(0)).rejects.toThrow('boom');
    get.mockRestore();
  });
});

describe('review regressions', () => {
  test('unknown capacity cannot mask an exhausted reporting account', () => {
    const forecast = forecastFor([account('empty', [sample(NOW, 0)]), account('unknown', [])]);
    expect(forecast.totalPercent).toBe(100);
    expect(forecast.remainingPercent).toBe(0);
    expect(forecast.notReportingCount).toBe(1);
    expect(forecast.stats.poolEmptyAt).toBe(NOW);
  });

  test('all unknown accounts yield no chart or stats', () => {
    const forecast = forecastFor([
      account('unknown', []),
      account('future', [sample(NOW + HOUR, 100)]),
    ]);
    expect(forecast.notReportingCount).toBe(2);
    expect(forecast.totalPercent).toBe(0);
    expect(forecast.recorded).toEqual([]);
    expect(forecast.projected).toEqual([]);
    expect(forecast.stats.poolEmptyAt).toBeNull();
    expect(forecast.stats.firstEmptyAt).toBeNull();
    expect(forecast.stats.nextReset).toBeNull();
  });

  test('same-second drops count, while upward resets do not', () => {
    expect(
      burnRate(
        [
          { t: NOW - HOUR, v: 60 },
          { t: NOW, v: 50 },
          { t: NOW, v: 40 },
          { t: NOW, v: 100 },
        ],
        NOW - HOUR,
        NOW
      )
    ).toBeCloseTo(20, 6);
    expect(
      burnRate(
        [
          { t: NOW - HOUR, v: 60 },
          { t: NOW - HOUR, v: 50 },
          { t: NOW, v: 40 },
        ],
        NOW - HOUR,
        NOW
      )
    ).toBeCloseTo(10, 6);
  });

  test('depletion exactly at a reset or endpoint is detected', () => {
    const end = NOW + 2 * HOUR;
    expect(projectAccount(10, 5, [], NOW, end).emptyAt).toBe(end);
    const atReset = projectAccount(10, 5, [end], NOW, end + HOUR);
    expect(atReset.emptyAt).toBe(end);
    expect(valueAt(atReset.points, end, 'before')).toBe(0);
    expect(valueAt(atReset.points, end, 'after')).toBe(100);
  });
});
