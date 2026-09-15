import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { formatBytes } from "../debugLog";
import type { PageChannel } from "../pageChannel";
import { Empty, PanelToolbar } from "./parts";

interface PerformanceReport {
  navigation: { type: string; ttfbMs: number | null; domContentLoadedMs: number | null; loadMs: number | null; transferBytes: number | null } | null;
  firstContentfulPaintMs: number | null;
  /** La página cargó sin mostrarse y pintó recién al verse: el FCP mide eso, no la carga. */
  paintDeferred: boolean;
  largestContentfulPaintMs: number | null;
  cumulativeLayoutShift: number | null;
  longTasks: { count: number; totalMs: number } | null;
  memory: { usedJSHeapBytes: number; totalJSHeapBytes: number; limitBytes: number } | null;
  domNodes: number;
  resources: { count: number; transferBytes: number; byType: Record<string, number> };
  uptimeMs: number;
}

interface Sample {
  domNodes: number;
  heap: number | null;
}

/** Cada cuánto se mide mientras la pestaña está abierta. */
const SAMPLE_MS = 2000;
const MAX_SAMPLES = 60;

type Grade = "good" | "fair" | "poor" | null;

/** Los umbrales de Web Vitals: dónde "bien" pasa a "mejorable" y a "malo". */
function grade(value: number | null, good: number, poor: number): Grade {
  if (value === null) return null;
  return value <= good ? "good" : value <= poor ? "fair" : "poor";
}

const GRADE_TONE: Record<Exclude<Grade, null>, string> = {
  good: "text-emerald-600 dark:text-emerald-400",
  fair: "text-amber-600 dark:text-amber-400",
  poor: "text-red-600 dark:text-red-400",
};

function ms(value: number | null): string {
  if (value === null) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value} ms`;
}

function Metric({ label, value, tone, hint }: { label: string; value: string; tone?: Grade; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0" title={hint}>
      <span className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-white/30">{label}</span>
      <span className={`font-mono text-[15px] font-semibold tabular-nums ${tone ? GRADE_TONE[tone] : "text-gray-900 dark:text-gray-100"}`}>
        {value}
      </span>
    </div>
  );
}

function Card({ title, children, wide }: { title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className={`flex flex-col gap-2.5 p-3 rounded-lg bg-white dark:bg-white/3 border border-gray-200 dark:border-white/8
      ${wide ? "col-span-full sm:col-span-2" : ""}`}>
      <h3 className="text-[11px] font-semibold text-gray-600 dark:text-gray-300">{title}</h3>
      {children}
    </section>
  );
}

/** Una línea con la evolución de un número: lo que dice si algo crece sin parar. */
function Sparkline({ values, tone }: { values: number[]; tone: string }) {
  if (values.length < 3) return <div className="h-8" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - min) / span) * 26}`)
    .join(" ");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={`w-full h-8 ${tone}`}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * Cómo carga y cómo se comporta la página: los tiempos de carga, las Web Vitals que el
 * motor expone, la memoria y el tamaño del DOM a lo largo del tiempo.
 *
 * Lo que el motor no mide se dice así y no como cero: en WebKit no hay heap de JS ni
 * tareas largas, y un "0 MB" haría creer que la página no usa memoria.
 */
export function PerformanceView({ channel, docId }: { channel: PageChannel; docId: string | null }) {
  const { t } = useTranslation();
  const [report, setReport] = useState<PerformanceReport | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSamples([]);
    let alive = true;
    const tick = async () => {
      try {
        const next = await channel.run({ op: "performance" }) as PerformanceReport;
        if (!alive) return;
        setReport(next);
        setError(null);
        setSamples((prev) => [...prev, { domNodes: next.domNodes, heap: next.memory?.usedJSHeapBytes ?? null }].slice(-MAX_SAMPLES));
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
    const id = setInterval(tick, SAMPLE_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [channel, docId]);

  if (!report) {
    return <Empty>{error ?? t("browser.debug.loading")}</Empty>;
  }

  const nav = report.navigation;
  const heap = samples.map((s) => s.heap).filter((h): h is number => h !== null);
  const nodes = samples.map((s) => s.domNodes);
  const growth = nodes.length > 5 ? nodes[nodes.length - 1] - nodes[0] : 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      <PanelToolbar>
        <span className="text-[11px] text-gray-500 dark:text-white/40">
          {t("browser.debug.perf.live", { s: SAMPLE_MS / 1000 })}
        </span>
        {error && <span className="text-[11px] text-red-600 dark:text-red-400 truncate">{error}</span>}
      </PanelToolbar>

      <div className="flex-1 min-h-0 overflow-y-auto cc-scroll p-3">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2.5">
          <Card title={t("browser.debug.perf.load")}>
            <div className="grid grid-cols-3 gap-2">
              <Metric label="TTFB" value={ms(nav?.ttfbMs ?? null)} tone={grade(nav?.ttfbMs ?? null, 800, 1800)} />
              <Metric label="DCL" value={ms(nav?.domContentLoadedMs ?? null)} hint="DOMContentLoaded" />
              <Metric label="Load" value={ms(nav?.loadMs ?? null)} />
            </div>
          </Card>

          <Card title={t("browser.debug.perf.paint")}>
            <div className="grid grid-cols-3 gap-2">
              <Metric label="FCP" value={ms(report.firstContentfulPaintMs)} hint="First Contentful Paint"
                tone={report.paintDeferred ? null : grade(report.firstContentfulPaintMs, 1800, 3000)} />
              <Metric label="LCP" value={ms(report.largestContentfulPaintMs)} tone={grade(report.largestContentfulPaintMs, 2500, 4000)} hint="Largest Contentful Paint" />
              <Metric label="CLS" value={report.cumulativeLayoutShift === null ? "—" : report.cumulativeLayoutShift.toFixed(3)}
                tone={grade(report.cumulativeLayoutShift, 0.1, 0.25)} hint="Cumulative Layout Shift" />
            </div>
            {report.paintDeferred && (
              <p className="text-[10.5px] text-gray-400 dark:text-white/30">{t("browser.debug.perf.paintDeferred")}</p>
            )}
            {(report.largestContentfulPaintMs === null || report.cumulativeLayoutShift === null) && (
              <p className="text-[10.5px] text-gray-400 dark:text-white/30">{t("browser.debug.perf.vitalsUnavailable")}</p>
            )}
          </Card>

          <Card title={t("browser.debug.perf.memory")}>
            {report.memory ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <Metric label={t("browser.debug.perf.used")} value={formatBytes(report.memory.usedJSHeapBytes)} />
                  <Metric label={t("browser.debug.perf.limit")} value={formatBytes(report.memory.limitBytes)} />
                </div>
                <Sparkline values={heap} tone="text-violet-500" />
              </>
            ) : (
              <p className="text-[11px] leading-relaxed text-gray-500 dark:text-white/40">{t("browser.debug.perf.memoryUnavailable")}</p>
            )}
          </Card>

          <Card title={t("browser.debug.perf.dom")}>
            <div className="grid grid-cols-2 gap-2">
              <Metric label={t("browser.debug.perf.nodes")} value={report.domNodes.toLocaleString()} />
              <Metric label={t("browser.debug.perf.growth")} value={`${growth > 0 ? "+" : ""}${growth}`}
                tone={growth > 500 ? "poor" : growth > 100 ? "fair" : null} />
            </div>
            <Sparkline values={nodes} tone="text-blue-500" />
          </Card>

          <Card title={t("browser.debug.perf.longTasks")}>
            {report.longTasks ? (
              <div className="grid grid-cols-2 gap-2">
                <Metric label={t("browser.debug.perf.count")} value={String(report.longTasks.count)} tone={report.longTasks.count > 0 ? "fair" : "good"} />
                <Metric label={t("browser.debug.perf.blocked")} value={ms(report.longTasks.totalMs)} />
              </div>
            ) : (
              <p className="text-[11px] leading-relaxed text-gray-500 dark:text-white/40">{t("browser.debug.perf.longTasksUnavailable")}</p>
            )}
          </Card>

          <Card title={t("browser.debug.perf.resources")}>
            <div className="grid grid-cols-2 gap-2">
              <Metric label={t("browser.debug.perf.count")} value={String(report.resources.count)} />
              <Metric label={t("browser.debug.perf.transferred")} value={formatBytes(report.resources.transferBytes)} />
            </div>
            <div className="flex flex-wrap gap-1">
              {Object.entries(report.resources.byType).sort((a, b) => b[1] - a[1]).map(([type, n]) => (
                <span key={type} className="px-1.5 h-4 rounded text-[9.5px] font-semibold leading-4 bg-gray-200/80 dark:bg-white/8 text-gray-600 dark:text-white/50">
                  {type} {n}
                </span>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
