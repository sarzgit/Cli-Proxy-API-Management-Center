import type { QuotaHistory, QuotaHistoryAccount, QuotaHistorySample } from '@/types';
import { isRecord } from '@/utils/helpers';
import { apiClient } from './client';

const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const readString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const readFinite = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Unix seconds → epoch ms; 0, negatives and junk are "unknown". */
const readUnixSeconds = (value: unknown): number | null => {
  const seconds = readFinite(value);
  return seconds !== null && seconds > 0 ? Math.round(seconds * 1000) : null;
};

const normalizeSample = (value: unknown): QuotaHistorySample | null => {
  const raw = asRecord(value);
  const atMs = readUnixSeconds(raw.t);
  const remaining = readFinite(raw.remaining_percent);
  if (atMs === null || remaining === null) return null;
  return {
    atMs,
    remainingPercent: Math.min(100, Math.max(0, remaining)),
    resetAtMs: readUnixSeconds(raw.reset_at),
  };
};

const normalizeAccount = (value: unknown): QuotaHistoryAccount | null => {
  const raw = asRecord(value);
  const authId = readString(raw.auth_id);
  const provider = readString(raw.provider).toLowerCase();
  if (!authId || !provider) return null;
  const windowMinutes = readFinite(raw.window_minutes);
  const samples = (Array.isArray(raw.samples) ? raw.samples : [])
    .map(normalizeSample)
    .filter((sample): sample is QuotaHistorySample => sample !== null)
    .sort((a, b) => a.atMs - b.atMs);
  return {
    authId,
    provider,
    label: readString(raw.label),
    fileName: readString(raw.file_name),
    disabled: raw.disabled === true,
    windowMinutes: windowMinutes !== null && windowMinutes > 0 ? windowMinutes : null,
    samples,
  };
};

export function normalizeQuotaHistory(payload: unknown): QuotaHistory {
  const raw = asRecord(payload);
  return {
    generatedAtMs: readUnixSeconds(raw.generated_at),
    accounts: (Array.isArray(raw.accounts) ? raw.accounts : [])
      .map(normalizeAccount)
      .filter((account): account is QuotaHistoryAccount => account !== null),
  };
}

const isNotFound = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'status' in error && error.status === 404;

export const quotaHistoryApi = {
  /**
   * Recorded samples since `sinceMs`. Resolves null when the backend predates
   * the endpoint (404), so callers can hide the feature instead of erroring.
   */
  async fetch(sinceMs: number): Promise<QuotaHistory | null> {
    try {
      const payload = await apiClient.get<unknown>('/quota/history', {
        params: { since: Math.floor(sinceMs / 1000) },
      });
      return normalizeQuotaHistory(payload);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  },
};
