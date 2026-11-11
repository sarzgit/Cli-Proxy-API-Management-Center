/**
 * Synthetic `/quota/history` payload (raw backend shape) for the dev preview
 * and tests. Deterministic for a given `nowMs`; no real accounts.
 */

const HOUR_S = 3600;
const WEEK_MINUTES = 7 * 24 * 60;

interface FixtureAccount {
  provider: string;
  index: number;
  /** %/h burned while the window is open. */
  burn: number;
  /** Days from now until the next reset. */
  resetInDays: number;
  disabled?: boolean;
  noSamples?: boolean;
}

const ACCOUNTS: FixtureAccount[] = [
  { provider: 'claude', index: 1, burn: 0.55, resetInDays: 0.9 },
  { provider: 'claude', index: 2, burn: 0.8, resetInDays: 2.4 },
  { provider: 'claude', index: 3, burn: 0.35, resetInDays: 3.6 },
  { provider: 'claude', index: 4, burn: 1.1, resetInDays: 4.2 },
  { provider: 'claude', index: 5, burn: 0.6, resetInDays: 5.5 },
  { provider: 'claude', index: 6, burn: 0.25, resetInDays: 6.3 },
  { provider: 'claude', index: 7, burn: 2, resetInDays: 1, disabled: true },
  { provider: 'codex', index: 1, burn: 0.9, resetInDays: 1.7 },
  { provider: 'codex', index: 2, burn: 0.7, resetInDays: 3.1 },
  { provider: 'codex', index: 3, burn: 1.3, resetInDays: 4.8 },
  { provider: 'codex', index: 4, burn: 0, resetInDays: 0, noSamples: true },
];

export function buildPooledForecastFixture(nowMs: number, historyDays = 4) {
  const nowS = Math.floor(nowMs / 1000);
  const windowS = WEEK_MINUTES * 60;
  return {
    generated_at: nowS,
    accounts: ACCOUNTS.map((account) => {
      const name = `${account.provider}-pool-${account.index}.json`;
      const nextReset = nowS + Math.round(account.resetInDays * 24 * HOUR_S);
      const samples = account.noSamples
        ? []
        : Array.from({ length: historyDays * 48 + 1 }, (_, step) => {
            const t = nowS - historyDays * 24 * HOUR_S + step * 1800;
            // Reset that closes the window containing t.
            let resetAt = nextReset;
            while (resetAt - windowS > t) resetAt -= windowS;
            // Usage accumulates since the window opened, quieter overnight so
            // the drain view has some shape.
            let used = 0;
            for (let at = resetAt - windowS; at < t; at += 1800) {
              const hour = new Date(at * 1000).getHours();
              used += account.burn * 0.5 * (hour >= 1 && hour < 8 ? 0.3 : 1.2);
            }
            return {
              t,
              remaining_percent: Math.max(0, Math.round((100 - used) * 10) / 10),
              reset_at: resetAt,
            };
          });
      return {
        auth_id: name,
        provider: account.provider,
        label: `pool-${account.index}@example.test`,
        file_name: name,
        disabled: account.disabled === true,
        window_minutes: WEEK_MINUTES,
        samples,
      };
    }),
  };
}
