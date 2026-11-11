/**
 * Inline SVG chart for one provider's pooled quota. Geometry only: every value
 * comes from the ProviderForecast built in pooledForecast.ts.
 *
 * The SVG is drawn at the measured pixel width (not a stretched viewBox) so
 * text and strokes keep their size at any card width.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import {
  dayTicks,
  forecastValueAt,
  type ForecastSpan,
  type ForecastView,
  type ProviderForecast,
  type SeriesPoint,
  valueAt,
} from '../pooledForecast';
import {
  formatDayTick,
  formatPercent,
  formatRate,
  formatWeekdayTime,
} from '../pooledForecastFormat';
import styles from './PooledForecast.module.scss';

export const CHART_HEIGHT = 300;
const DEFAULT_WIDTH = 720;
const MARGIN = { top: 28, right: 14, bottom: 28, left: 52 };
/** Minimum horizontal gap between reset labels before one is dropped. */
const RESET_LABEL_GAP = 40;

export interface PooledForecastChartProps {
  forecast: ProviderForecast;
  view: ForecastView;
  span: ForecastSpan;
  nowMs: number;
  /** Accessible name, e.g. the provider label. */
  label: string;
}

/** Round a drain-rate maximum up to 1, 2 or 5 × 10ⁿ. */
const niceCeil = (value: number): number => {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((candidate) => candidate * power >= value) ?? 10;
  return step * power;
};

export function PooledForecastChart({
  forecast,
  view,
  span,
  nowMs,
  label,
}: PooledForecastChartProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const gradientId = `pool-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [cursor, setCursor] = useState<number | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const plotWidth = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
  const spanMs = span.endMs - span.startMs;

  const recorded = view === 'remaining' ? forecast.recorded : forecast.drainRecorded;
  const projected = view === 'remaining' ? forecast.projected : forecast.drainProjected;
  const yMax =
    view === 'remaining'
      ? forecast.totalPercent
      : niceCeil(Math.max(...recorded.map((p) => p.v), ...projected.map((p) => p.v), 0) * 1.15);
  const formatValue = (value: number) =>
    view === 'remaining' ? formatPercent(value) : formatRate(t, value);

  const x = (ms: number) => MARGIN.left + ((ms - span.startMs) / spanMs) * plotWidth;
  const y = (value: number) =>
    MARGIN.top + (1 - Math.min(Math.max(value / yMax, 0), 1)) * plotHeight;
  const baseline = MARGIN.top + plotHeight;

  const linePath = (points: SeriesPoint[]) =>
    points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)
      .join('');
  const areaPath = (points: SeriesPoint[]) =>
    points.length < 2
      ? ''
      : `${linePath(points)}L${x(points[points.length - 1].t).toFixed(1)},${baseline}` +
        `L${x(points[0].t).toFixed(1)},${baseline}Z`;

  const ticks = useMemo(() => dayTicks(span.startMs, span.endMs), [span]);
  const tickEvery = Math.max(1, Math.ceil(ticks.length / Math.max(1, Math.floor(plotWidth / 64))));

  const resetLabels = useMemo(() => {
    if (view !== 'remaining') return [];
    const labels: { t: number; restored: number; after: number }[] = [];
    let lastX = -Infinity;
    forecast.resetSteps.forEach((step) => {
      const stepX = MARGIN.left + ((step.t - span.startMs) / spanMs) * plotWidth;
      if (step.restored < 0.5 || stepX - lastX < RESET_LABEL_GAP) return;
      lastX = stepX;
      labels.push({ ...step, after: valueAt(projected, step.t, 'after') });
    });
    return labels;
  }, [view, forecast.resetSteps, projected, span.startMs, spanMs, plotWidth]);

  const nowVisible = nowMs >= span.startMs && nowMs <= span.endMs;
  const reading = cursor === null ? null : forecastValueAt(forecast, view, cursor, nowMs);
  const readingText =
    cursor === null || reading === null
      ? ''
      : view === 'remaining'
        ? t('quota_management.pool_tooltip_remaining', {
            time: formatWeekdayTime(cursor, locale),
            value: formatPercent(reading.value),
            kind: t(
              reading.projected
                ? 'quota_management.pool_projected'
                : 'quota_management.pool_recorded'
            ),
          })
        : t('quota_management.pool_tooltip_rate', {
            time: formatWeekdayTime(cursor, locale),
            value: formatRate(t, reading.value),
            kind: t(
              reading.projected
                ? 'quota_management.pool_projected'
                : 'quota_management.pool_recorded'
            ),
          });

  const clampToSpan = (ms: number) => Math.min(Math.max(ms, span.startMs), span.endMs);

  const handlePointer = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left - MARGIN.left) / plotWidth;
    if (ratio < 0 || ratio > 1) {
      setCursor(null);
      return;
    }
    setCursor(span.startMs + ratio * spanMs);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const base = cursor ?? clampToSpan(nowMs);
    const moves: Record<string, number> = {
      ArrowLeft: -HOUR_MS,
      ArrowRight: HOUR_MS,
      PageUp: -DAY_MS,
      PageDown: DAY_MS,
    };
    if (event.key in moves) {
      setCursor(clampToSpan(base + moves[event.key] * (event.shiftKey ? 6 : 1)));
    } else if (event.key === 'Home') {
      setCursor(span.startMs);
    } else if (event.key === 'End') {
      setCursor(span.endMs);
    } else if (event.key === 'Escape') {
      setCursor(null);
    } else {
      return;
    }
    event.preventDefault();
  };

  const summary = t('quota_management.pool_chart_summary', {
    provider: label,
    remaining: formatPercent(forecast.remainingPercent),
    total: formatPercent(forecast.totalPercent),
    rate: formatRate(t, forecast.burnPerHour),
  });

  const cursorX = cursor === null ? null : x(cursor);
  const tooltipLeft =
    cursorX === null ? 0 : Math.min(Math.max(cursorX, MARGIN.left + 90), width - 90);

  return (
    <div
      ref={containerRef}
      className={styles.chart}
      style={{ height: CHART_HEIGHT }}
      tabIndex={0}
      role="group"
      aria-label={summary}
      aria-roledescription={t('quota_management.pool_chart_role')}
      onKeyDown={handleKeyDown}
      onFocus={() => setCursor((value) => value ?? clampToSpan(nowMs))}
      onBlur={() => setCursor(null)}
    >
      <svg
        width={width}
        height={CHART_HEIGHT}
        viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
        aria-hidden="true"
        onPointerMove={handlePointer}
        onPointerLeave={() => setCursor(null)}
      >
        <defs>
          <linearGradient id={`${gradientId}-rec`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className={styles.fillStopTop} />
            <stop offset="100%" className={styles.fillStopBottom} />
          </linearGradient>
          <linearGradient id={`${gradientId}-proj`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className={styles.fillStopTopLight} />
            <stop offset="100%" className={styles.fillStopBottom} />
          </linearGradient>
          <clipPath id={`${gradientId}-plot`}>
            <rect x={MARGIN.left} y={0} width={plotWidth} height={baseline + 1} />
          </clipPath>
        </defs>

        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction}>
            <line
              className={styles.gridLine}
              x1={MARGIN.left}
              x2={MARGIN.left + plotWidth}
              y1={y(yMax * fraction)}
              y2={y(yMax * fraction)}
            />
            <text
              className={styles.axisText}
              x={MARGIN.left - 8}
              y={y(yMax * fraction)}
              textAnchor="end"
              dominantBaseline="middle"
            >
              {formatValue(yMax * fraction)}
            </text>
          </g>
        ))}

        {ticks.map((tick, index) =>
          index % tickEvery === 0 ? (
            <text
              key={tick}
              className={styles.axisText}
              x={x(tick)}
              y={CHART_HEIGHT - 8}
              textAnchor={index === 0 && tick - span.startMs < DAY_MS / 4 ? 'start' : 'middle'}
            >
              {formatDayTick(tick, locale)}
            </text>
          ) : null
        )}

        <g clipPath={`url(#${gradientId}-plot)`}>
          <path className={styles.area} d={areaPath(projected)} fill={`url(#${gradientId}-proj)`} />
          <path className={styles.area} d={areaPath(recorded)} fill={`url(#${gradientId}-rec)`} />
          <path className={styles.projectedLine} d={linePath(projected)} />
          <path className={styles.recordedLine} d={linePath(recorded)} />
        </g>

        {resetLabels.map((reset) => (
          <text
            key={reset.t}
            className={styles.resetLabel}
            x={x(reset.t)}
            y={Math.max(y(reset.after) - 7, 12)}
            textAnchor="middle"
          >
            +{formatPercent(reset.restored)}
          </text>
        ))}

        {nowVisible && (
          <g>
            <line
              className={styles.nowLine}
              x1={x(nowMs)}
              x2={x(nowMs)}
              y1={MARGIN.top - 6}
              y2={baseline}
            />
            <text className={styles.nowLabel} x={x(nowMs)} y={MARGIN.top - 12} textAnchor="middle">
              {t('quota_management.pool_now')}
            </text>
          </g>
        )}

        {cursorX !== null && (
          <g>
            <line
              className={styles.crosshair}
              x1={cursorX}
              x2={cursorX}
              y1={MARGIN.top}
              y2={baseline}
            />
            {reading && (
              <circle className={styles.cursorDot} cx={cursorX} cy={y(reading.value)} r={4} />
            )}
          </g>
        )}
      </svg>

      {readingText && (
        <div className={styles.tooltip} style={{ left: tooltipLeft }} aria-hidden="true">
          {readingText}
        </div>
      )}
      <span className={styles.srOnly} aria-live="polite">
        {readingText}
      </span>
    </div>
  );
}
