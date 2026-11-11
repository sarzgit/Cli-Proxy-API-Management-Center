import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n/index';
import { PooledForecastView } from '../src/features/quota/components/PooledForecast';
import { buildPooledForecastFixture } from '../src/features/quota/preview/pooledForecastFixture';
import { normalizeQuotaHistory } from '../src/services/api/quotaHistory';

const NOW = new Date(2026, 10, 10, 12).getTime();

const render = (history = normalizeQuotaHistory(buildPooledForecastFixture(NOW))) =>
  renderToStaticMarkup(
    createElement(PooledForecastView, { history, nowMs: NOW, resolvedTheme: 'dark' })
  );

describe('PooledForecastView static rendering', () => {
  const originalLanguage = i18n.language;
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });
  afterAll(async () => {
    await i18n.changeLanguage(originalLanguage);
  });

  test('renders one card per provider with enabled accounts', () => {
    const markup = render();

    // Claude: 6 enabled (one disabled excluded); Codex: 4 including one with no samples.
    expect(markup).toContain('6 accounts');
    expect(markup).toContain('of 600%');
    expect(markup).toContain('4 accounts');
    expect(markup).toContain('of 400%');
    expect(markup.indexOf('of 600%')).toBeLessThan(markup.indexOf('of 400%'));
    expect(markup).toContain('--pool-claude');
    expect(markup).toContain('--pool-codex');
  });

  test('shows the toolbar, stats, chart and legend', () => {
    const markup = render();

    for (const text of [
      'Remaining',
      'Drain rate',
      'Burn rate',
      'Future usage',
      'Same as now',
      'Today',
      'Pool empty',
      'First empty',
      'Next reset',
      'Burn, last 3h',
      'Recorded',
      'Projected',
    ]) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain('Nov 7 to Nov 20');
    expect(markup).toMatch(/aria-pressed="true"[^>]*>3h</);
    expect(markup).toMatch(/<svg[^>]*height="300"/);
    expect(markup).toMatch(/>Now<\/text>/);
    // Projected resets are labelled with what they restore.
    expect(markup).toMatch(/>\+\d+%<\/text>/);
    // Focusable chart with an accessible summary.
    expect(markup).toMatch(/tabindex="0" role="group" aria-label="Claude pool: \d+% of 600% left/);
    expect(markup).toMatch(/\d+\.\d%\/h/);
  });

  test('renders nothing without enabled accounts', () => {
    expect(render({ generatedAtMs: NOW, accounts: [] })).toBe('');
  });
});
