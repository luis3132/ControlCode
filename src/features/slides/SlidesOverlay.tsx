import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";

import { canvasToPng, freezePage } from "@/features/browser/annotate/capture";

import { SlideFrame } from "./SlideFrame";
import { mountedAround, useBox } from "./SlidesView";
import { cancelExport, goTo, present, registerCapture, useSlidesStore, watchDeck } from "./store";

/**
 * Lo que tapa toda la ventana: la presentación a pantalla completa, o la exportación a PDF
 * mostrando cada hoja para capturarla. Va montado siempre (en `AppShell`) y aparece solo
 * cuando hace falta.
 */
export function SlidesOverlay() {
  const presenting = useSlidesStore((s) => s.presenting);
  const exporting = useSlidesStore((s) => s.exporting);
  if (exporting) return createPortal(<Exporter dir={exporting.dir} index={exporting.index} total={exporting.total} />, document.body);
  if (presenting) return createPortal(<Presenter dir={presenting} />, document.body);
  return null;
}

const LAYER = "fixed inset-0 bg-black select-none";
const Z = { zIndex: 2147483100 };

/** Presentar: la hoja entera, las flechas, Esc para salir. La ventana pasa a pantalla
 *  completa mientras dura, y vuelve como estaba. */
function Presenter({ dir }: { dir: string }) {
  const { t } = useTranslation();
  const entry = useSlidesStore((s) => s.decks[dir]);
  const current = useSlidesStore((s) => s.current[dir] ?? 0);
  const [ref, box] = useBox<HTMLDivElement>();
  const deck = entry && "deck" in entry ? entry.deck : null;
  const total = deck?.slides.length ?? 0;

  useEffect(() => watchDeck(dir), [dir]);

  useEffect(() => {
    const win = getCurrentWindow();
    let wasFullscreen = true;
    win.isFullscreen().then((full) => {
      wasFullscreen = full;
      if (!full) win.setFullscreen(true).catch(() => {});
    }).catch(() => {});
    return () => {
      if (!wasFullscreen) win.setFullscreen(false).catch(() => {});
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) goTo(dir, current + 1);
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) goTo(dir, current - 1);
      else if (e.key === "Home") goTo(dir, 0);
      else if (e.key === "End") goTo(dir, total - 1);
      else if (e.key === "Escape") present(null);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dir, current, total]);

  return (
    <div className={LAYER} style={Z} onClick={() => goTo(dir, current + 1)}>
      <div ref={ref} className="absolute inset-0">
        {deck && box.width > 0 && mountedAround(current, total).map((i) => (
          <SlideFrame key={deck.slides[i]} dir={dir} name={deck.slides[i]!} size={deck.size} box={box} hidden={i !== current} />
        ))}
      </div>
      <div className="absolute bottom-3 right-4 flex items-center gap-3 text-xs text-white/40" onClick={(e) => e.stopPropagation()}>
        <span className="tabular-nums">{total ? current + 1 : 0} / {total}</span>
        <button className="px-2 py-1 rounded hover:bg-white/10 hover:text-white" onClick={() => present(null)}>{t("slides.exit")}</button>
      </div>
    </div>
  );
}

/** Exportar: muestra la hoja que toca, espera a que se dibuje y la captura. */
function Exporter({ dir, index, total }: { dir: string; index: number; total: number }) {
  const { t } = useTranslation();
  const entry = useSlidesStore((s) => s.decks[dir]);
  const deck = entry && "deck" in entry ? entry.deck : null;
  const [ref, box] = useBox<HTMLDivElement>();
  const [shown, setShown] = useState(index);
  const frame = useRef<HTMLIFrameElement>(null);
  const loaded = useRef<{ index: number; resolve: () => void } | null>(null);

  const onLoad = useCallback(() => {
    if (loaded.current) {
      loaded.current.resolve();
      loaded.current = null;
    }
  }, []);

  const ready = box.width > 0 && !!deck;
  useEffect(() => {
    if (!ready) return;
    registerCapture(async (i) => {
      const loadedNow = new Promise<void>((resolve) => {
        loaded.current = { index: i, resolve };
      });
      setShown(i);
      // Que cargue (con un tope: una hoja rota no traba la exportación) y que se pinte.
      await Promise.race([loadedNow, new Promise((r) => setTimeout(r, 3000))]);
      await new Promise((r) => setTimeout(r, 250));
      const iframe = frame.current;
      const container = ref.current;
      if (!iframe || !container) throw new Error("No se pudo mostrar la hoja");
      const frozen = await freezePage(iframe.parentElement as HTMLElement, container);
      return canvasToPng(frozen.canvas);
    });
    return () => registerCapture(null);
  }, [ready, ref]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelExport();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className={LAYER} style={Z}>
      <div ref={ref} className="absolute inset-0 bottom-10">
        {deck && box.width > 0 && deck.slides[shown] && (
          <SlideFrame ref={frame} key={deck.slides[shown]} dir={dir} name={deck.slides[shown]!} size={deck.size} box={box} onLoad={onLoad} />
        )}
      </div>
      <div className="absolute bottom-0 inset-x-0 h-10 flex items-center justify-center text-xs text-white/60">
        {t("slides.exportingPage", { n: index + 1, total })} · {t("slides.escCancels")}
      </div>
    </div>
  );
}
