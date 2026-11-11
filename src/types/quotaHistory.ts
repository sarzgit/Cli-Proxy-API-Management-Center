/**
 * Recorded quota history from `GET /v8/management/quota/history`.
 *
 * Instants are epoch milliseconds after normalization (the backend sends Unix
 * seconds). A null `resetAtMs` means the backend did not know the reset.
 */

export interface QuotaHistorySample {
  atMs: number;
  /** 0..100 */
  remainingPercent: number;
  resetAtMs: number | null;
}

export interface QuotaHistoryAccount {
  authId: string;
  provider: string;
  label: string;
  fileName: string;
  disabled: boolean;
  /** Quota window length; null when unknown. */
  windowMinutes: number | null;
  /** Ascending by `atMs`. */
  samples: QuotaHistorySample[];
}

export interface QuotaHistory {
  generatedAtMs: number | null;
  accounts: QuotaHistoryAccount[];
}
