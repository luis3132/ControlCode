import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { agentPaint } from "@/features/browser/agentPaint";
import { PRESENCE_MS, useCanvasStore } from "@/features/canvas/store";

import { exportDeckPdf } from "./export";
import { SlideFrame } from "./SlideFrame";
import { goTo, present, slidesPresenceKey, useSlidesStore, watchDeck } from "./store";

/** El tamaño de un elemento, al día. */
export function useBox<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setBox({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, box] as const;
}

/** Las hojas que van montadas: la actual y sus vecinas, para que pasar de una a otra no espere. */
export const mountedAround = (current: number, total: number) =>
  [current - 1, current, current + 1].filter((i) => i >= 0 && i < total);

/**
 * Una presentación: la hoja actual, con flechas para recorrerla, presentar a pantalla
 * completa y exportar a PDF. Con `thumbnails`, además la tira de miniaturas (en una tab).
 *
 * `interactive: false` (el canvas con zoom) solo la muestra.
 */
export function SlidesView({ dir, interactive = true, thumbnails = false }: { dir: string; interactive?: boolean; thumbnails?: boolean }) {
  const { t } = useTranslation();
  const entry = useSlidesStore((s) => s.decks[dir]);
  const current = useSlidesStore((s) => s.current[dir] ?? 0);
  const presence = useCanvasStore((s) => s.presence[slidesPresenceKey(dir)]);
  const [stageRef, box] = useBox<HTMLDivElement>();
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => watchDeck(dir), [dir]);

  if (entry && "error" in entry) {
    return <div className="flex items-center justify-center h-full p-6 text-center text-xs text-red-600">{entry.error}</div>;
  }
  const deck = entry?.deck;
  const total = deck?.slides.length ?? 0;
  const touching = presence && Date.now() - presence.at < PRESENCE_MS ? presence : null;

  const exportPdf = async () => {
    setStatus(t("slides.exporting"));
    try {
      const out = await exportDeckPdf(dir);
      setStatus(t("slides.exported", { file: out.split(/[\\/]/).pop() }));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
    setTimeout(() => setStatus(null), 6000);
  };

  return (
    <div
      className="absolute inset-0 flex bg-gray-200 dark:bg-surface-deep"
      tabIndex={interactive ? -1 : undefined}
      onKeyDown={(e) => {
        if (!interactive) return;
        if (["ArrowRight", "PageDown", " "].includes(e.key)) goTo(dir, current + 1);
        else if (["ArrowLeft", "PageUp"].includes(e.key)) goTo(dir, current - 1);
        else return;
        e.preventDefault();
      }}
    >
      {thumbnails && deck && (
        <div className="w-44 shrink-0 overflow-y-auto p-2 flex flex-col gap-2 border-r border-gray-300 dark:border-white/8">
          {deck.slides.map((name, i) => (
            <Thumbnail key={name} dir={dir} name={name} size={deck.size} index={i} active={i === current} />
          ))}
        </div>
      )}
      <div className="relative flex-1 min-w-0 flex flex-col">
        <div ref={stageRef} className="relative flex-1 min-h-0 m-3">
          {deck && total > 0 && box.width > 0 && mountedAround(current, total).map((i) => (
            <SlideFrame key={deck.slides[i]} dir={dir} name={deck.slides[i]!} size={deck.size} box={box} hidden={i !== current} />
          ))}
          {deck && total === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-500 dark:text-white/40">{t("slides.empty")}</div>
          )}
          {touching && (
            <span className="absolute top-1 left-1 px-1.5 rounded text-[10px] font-medium text-white" style={{ background: agentPaint(touching.id).hex }}>
              {touching.label}
            </span>
          )}
        </div>
        {interactive && deck && (
          <div className="nodrag flex items-center gap-1 h-8 px-2 shrink-0 text-[11px] text-gray-600 dark:text-white/55">
            <button className={BTN} disabled={current <= 0} onClick={() => goTo(dir, current - 1)} aria-label={t("slides.prev")}>◀</button>
            <span className="tabular-nums">{total ? current + 1 : 0} / {total}</span>
            <button className={BTN} disabled={current >= total - 1} onClick={() => goTo(dir, current + 1)} aria-label={t("slides.next")}>▶</button>
            <span className="flex-1 truncate px-2">{status ?? deck.title}</span>
            <button className={BTN} disabled={total === 0} onClick={() => void exportPdf()}>PDF</button>
            <button className={`${BTN} font-medium text-accent-600 dark:text-accent-300`} disabled={total === 0} onClick={() => present(dir)}>
              {t("slides.present")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const BTN = "px-2 h-6 rounded hover:bg-black/5 dark:hover:bg-white/8 disabled:opacity-35 disabled:hover:bg-transparent";

/** Una miniatura: se monta recién cuando entra en la tira a la vista. */
function Thumbnail({ dir, name, size, index, active }: { dir: string; name: string; size: { w: number; h: number }; index: number; active: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([e]) => setSeen(!!e?.isIntersecting), { rootMargin: "200px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const width = 160;
  const height = (width * size.h) / size.w;
  return (
    <button
      ref={ref}
      onClick={() => goTo(dir, index)}
      className={`relative shrink-0 rounded overflow-hidden ${active ? "ring-2 ring-accent-500" : "ring-1 ring-black/10 dark:ring-white/10"}`}
      style={{ width, height }}
    >
      {seen && <SlideFrame dir={dir} name={name} size={size} box={{ width, height }} />}
      <span className="absolute bottom-0.5 left-1 text-[10px] text-gray-500">{index + 1}</span>
    </button>
  );
}
