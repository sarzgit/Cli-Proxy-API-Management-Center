import { useEffect, useRef, useState } from 'react';
import { quotaHistoryApi } from '@/services/api';
import { useAuthStore, useQuotaStore } from '@/stores';
import type { QuotaHistory } from '@/types';

interface LoadedHistory {
  generation: number;
  history: QuotaHistory | null;
}

/**
 * Pooled quota history for the forecast cards. Resolves null while loading,
 * when disconnected, and when the backend has no history endpoint (404), so
 * the cards simply stay hidden. Other failures keep the last good response.
 */
export function usePooledQuotaHistory(sinceMs: number, refreshKey: unknown): QuotaHistory | null {
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const generation = useQuotaStore((state) => state.cacheGeneration);
  const [loaded, setLoaded] = useState<LoadedHistory | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!connected) return;
    const requestId = ++requestRef.current;
    const isCurrent = () =>
      requestId === requestRef.current && generation === useQuotaStore.getState().cacheGeneration;
    quotaHistoryApi
      .fetch(sinceMs)
      .then((history) => {
        if (isCurrent()) setLoaded({ generation, history });
      })
      .catch(() => {
        // Keep showing the previous history; the page reports connection errors.
      });
    return () => {
      requestRef.current += 1;
    };
  }, [connected, generation, sinceMs, refreshKey]);

  return connected && loaded?.generation === generation ? loaded.history : null;
}
