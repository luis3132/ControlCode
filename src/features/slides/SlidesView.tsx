import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";

import { agentPaint } from "@/features/browser/agentPaint";
import { PRESENCE_MS, useCanvasStore } from "@/features/canvas/store";
import { useTabsStore } from "@/features/tabs/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";

import { SIZE_PRESETS, SLIDE_LAYOUTS, THEMES, joinPath, layoutBody, newSlideName, type LayoutTexts, type SlideLayout } from "./deck";
import { EditableSlide, type EditableSlideHandle } from "./EditableSlide";
import { exportDeckPdf } from "./export";
import { SlideFrame } from "./SlideFrame";
import {
  addLayoutSlide, applyTheme, duplicateSlide, goTo, importImage, loadDeck, present, removeSlide, reorderSlide, resizeDeck,
  slidesPresenceKey, useSlidesStore, watchDeck, writeSlide,
} from "./store";

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

/** La clave de texto de cada tamaño (i18next usa `:` para otra cosa, así que no puede ir en la clave). */
const SIZE_KEYS: Record<string, string> = { "16:9": "wide", "4:3": "standard", a4: "a4", "a4-landscape": "a4Landscape" };

const IMAGE_FILTER = [{ name: "Imágenes", extensions: ["png", "jpg", "jpeg", "svg", "webp", "gif"] }];

/** Los textos de ejemplo de cada diseño, en el idioma de la interfaz. */
function useLayoutTexts(): LayoutTexts {
  const { t } = useTranslation();
  return {
    title: t("slides.sample.title"),
    subtitle: t("slides.sample.subtitle"),
    heading: t("slides.sample.heading"),
    point: (n) => t("slides.sample.point", { n }),
    quote: t("slides.sample.quote"),
    author: t("slides.sample.author"),
    caption: t("slides.sample.caption"),
  };
}

/**
 * Una presentación: verla, recorrerla y armarla a mano. Hojas nuevas con un diseño, el texto
 * se edita escribiendo sobre la hoja, imágenes, tema y tamaño; presentar a pantalla completa
 * y exportar a PDF. Con `thumbnails` (en una tab) la tira de miniaturas, que se reordena
 * arrastrando.
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
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<"layout" | "theme" | "size" | null>(null);
  const editor = useRef<EditableSlideHandle>(null);
  const texts = useLayoutTexts();

  useEffect(() => watchDeck(dir), [dir]);
  useEffect(() => {
    if (!interactive) setEditing(false);
  }, [interactive]);

  if (entry && "error" in entry) {
    return <div className="flex items-center justify-center h-full p-6 text-center text-xs text-red-600">{entry.error}</div>;
  }
  const deck = entry?.deck;
  const total = deck?.slides.length ?? 0;
  const touching = presence && Date.now() - presence.at < PRESENCE_MS ? presence : null;

  const run = (job: Promise<unknown>) => {
    setMenu(null);
    job.catch((e: unknown) => {
      setStatus(e instanceof Error ? e.message : String(e));
      setTimeout(() => setStatus(null), 6000);
    });
  };

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

  const addSlide = (layout: SlideLayout) => run(addLayoutSlide(dir, layout, texts, total ? current : undefined).then(() => setEditing(true)));

  const pickImage = () => run((async () => {
    const picked = await openDialog({ multiple: false, filters: IMAGE_FILTER });
    if (typeof picked !== "string") return;
    const image = await importImage(dir, picked);
    if (editing && editor.current) editor.current.insertImage(image.ref, image.data);
    else {
      // Sin editar: una hoja nueva con esa imagen.
      const d = await loadDeck(dir);
      await writeSlide(dir, newSlideName(d, "imagen"), layoutBody("image", texts, image.ref), { insertAt: total ? current + 1 : undefined });
    }
  })());

  const openHtml = () => {
    const name = deck?.slides[current];
    if (!name) return;
    const { tabs, activeTabId } = useTabsStore.getState();
    const cwd = tabs.find((x) => x.id === activeTabId)?.cwd ?? dir;
    useViewTabsStore.getState().openFile(cwd, joinPath(dir, name));
  };

  const fmt = (command: string, value?: string) => editor.current?.exec(command, value);

  return (
    <div
      className="absolute inset-0 flex bg-gray-200 dark:bg-surface-deep"
      tabIndex={interactive ? -1 : undefined}
      onKeyDown={(e) => {
        if (!interactive || editing) return;
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
          <button className="shrink-0 h-10 rounded border border-dashed border-gray-400/60 text-xs text-gray-500 hover:bg-white/50 dark:hover:bg-white/5"
            onClick={() => setMenu("layout")}>+ {t("slides.add")}</button>
        </div>
      )}
      <div className="relative flex-1 min-w-0 flex flex-col">
        {interactive && deck && (
          <div className="nodrag relative flex flex-wrap items-center gap-0.5 px-2 py-1 shrink-0 text-[11px] text-gray-600 dark:text-white/60
            border-b border-gray-300/60 dark:border-white/8 bg-gray-100 dark:bg-surface-sunken">
            <Menu open={menu === "layout"} onToggle={() => setMenu(menu === "layout" ? null : "layout")} label={`+ ${t("slides.add")}`}>
              {SLIDE_LAYOUTS.map((layout) => (
                <MenuButton key={layout} onClick={() => addSlide(layout)}>{t(`slides.layout.${layout}`)}</MenuButton>
              ))}
            </Menu>
            <Btn disabled={!total} onClick={() => run(duplicateSlide(dir, current))}>{t("slides.duplicate")}</Btn>
            <Btn disabled={!total} onClick={() => run(removeSlide(dir, current))}>{t("slides.remove")}</Btn>
            <Sep />
            <Btn disabled={!total} active={editing} onClick={() => setEditing((v) => !v)}>{editing ? t("slides.doneEditing") : t("slides.editText")}</Btn>
            {editing && (
              <>
                <Btn onClick={() => fmt("bold")}><b>B</b></Btn>
                <Btn onClick={() => fmt("italic")}><i>I</i></Btn>
                <Btn onClick={() => fmt("formatBlock", "h1")}>{t("slides.fmt.title")}</Btn>
                <Btn onClick={() => fmt("formatBlock", "h2")}>{t("slides.fmt.heading")}</Btn>
                <Btn onClick={() => fmt("formatBlock", "p")}>{t("slides.fmt.text")}</Btn>
                <Btn onClick={() => fmt("insertUnorderedList")}>• {t("slides.fmt.list")}</Btn>
                <Btn onClick={() => fmt("insertOrderedList")}>1. {t("slides.fmt.list")}</Btn>
              </>
            )}
            <Btn onClick={pickImage}>{t("slides.image")}</Btn>
            <Sep />
            <Menu open={menu === "theme"} onToggle={() => setMenu(menu === "theme" ? null : "theme")} label={t("slides.theme")}>
              {THEMES.map((name) => (
                <MenuButton key={name} onClick={() => run(applyTheme(dir, name))}>{t(`slides.themes.${name}`)}</MenuButton>
              ))}
            </Menu>
            <Menu open={menu === "size"} onToggle={() => setMenu(menu === "size" ? null : "size")} label={`${deck.size.w}×${deck.size.h}`}>
              {Object.entries(SIZE_PRESETS).map(([key, size]) => (
                <MenuButton key={key} onClick={() => run(resizeDeck(dir, size))}>{t(`slides.sizes.${SIZE_KEYS[key] ?? key}`)}</MenuButton>
              ))}
            </Menu>
            <Btn disabled={!total} onClick={openHtml}>HTML</Btn>
          </div>
        )}
        <div ref={stageRef} className="relative flex-1 min-h-0 m-3">
          {deck && total > 0 && box.width > 0 && !editing && mountedAround(current, total).map((i) => (
            <SlideFrame key={deck.slides[i]} dir={dir} name={deck.slides[i]!} size={deck.size} box={box} hidden={i !== current} />
          ))}
          {deck && total > 0 && box.width > 0 && editing && deck.slides[current] && (
            <EditableSlide ref={editor} key={deck.slides[current]} dir={dir} name={deck.slides[current]!} size={deck.size} box={box} />
          )}
          {deck && total === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-xs text-gray-500 dark:text-white/45">
              <p>{interactive ? t("slides.firstSlide") : t("slides.empty")}</p>
              {interactive && (
                <div className="nodrag grid grid-cols-3 gap-2">
                  {SLIDE_LAYOUTS.map((layout) => (
                    <button key={layout} onClick={() => addSlide(layout)}
                      className="px-3 py-2 rounded-md bg-white dark:bg-surface-raised ring-1 ring-black/10 dark:ring-white/10 hover:ring-accent-500/60">
                      {t(`slides.layout.${layout}`)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {touching && (
            <span className="absolute top-1 left-1 px-1.5 rounded text-[10px] font-medium text-white" style={{ background: agentPaint(touching.id).hex }}>
              {touching.label}
            </span>
          )}
        </div>
        {interactive && deck && (
          <div className="nodrag flex items-center gap-1 h-8 px-2 shrink-0 text-[11px] text-gray-600 dark:text-white/55">
            <Btn disabled={current <= 0} onClick={() => goTo(dir, current - 1)}>◀</Btn>
            <span className="tabular-nums">{total ? current + 1 : 0} / {total}</span>
            <Btn disabled={current >= total - 1} onClick={() => goTo(dir, current + 1)}>▶</Btn>
            <span className="flex-1 truncate px-2">{status ?? deck.title}</span>
            <Btn disabled={total === 0} onClick={() => void exportPdf()}>PDF</Btn>
            <Btn disabled={total === 0} onClick={() => present(dir)}>
              <span className="font-medium text-accent-600 dark:text-accent-300">▶ {t("slides.present")}</span>
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
}

function Btn({ onClick, disabled, active, children }: { onClick: () => void; disabled?: boolean; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      // Que el botón no le saque el cursor a la hoja que se está editando.
      onMouseDown={(e) => e.preventDefault()}
      className={`px-2 h-6 rounded whitespace-nowrap disabled:opacity-35 disabled:hover:bg-transparent ${active
        ? "bg-accent-500/15 text-accent-700 dark:text-accent-200"
        : "hover:bg-black/5 dark:hover:bg-white/8"}`}
    >
      {children}
    </button>
  );
}

const Sep = () => <span className="w-px h-4 mx-1 bg-gray-300 dark:bg-white/10" />;

function Menu({ open, onToggle, label, children }: { open: boolean; onToggle: () => void; label: string; children: React.ReactNode }) {
  return (
    <div className="relative">
      <Btn active={open} onClick={onToggle}>{label} ▾</Btn>
      {open && (
        <div className="absolute left-0 top-7 z-20 min-w-40 py-1 rounded-md shadow-lg bg-white dark:bg-surface-raised ring-1 ring-black/10 dark:ring-white/10">
          {children}
        </div>
      )}
    </div>
  );
}

function MenuButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} onMouseDown={(e) => e.preventDefault()}
      className="block w-full text-left px-3 py-1.5 text-[11.5px] text-gray-700 dark:text-white/75 hover:bg-gray-100 dark:hover:bg-white/8">
      {children}
    </button>
  );
}

/** Una miniatura: se monta recién cuando entra en la tira a la vista, y se arrastra para
 *  cambiarla de lugar. */
function Thumbnail({ dir, name, size, index, active }: { dir: string; name: string; size: { w: number; h: number }; index: number; active: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [seen, setSeen] = useState(false);
  const [over, setOver] = useState(false);
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
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/x-cc-slide", String(index))}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("text/x-cc-slide")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const from = Number(e.dataTransfer.getData("text/x-cc-slide"));
        if (Number.isFinite(from) && from !== index) reorderSlide(dir, from, index).catch(console.error);
      }}
      onClick={() => goTo(dir, index)}
      className={`relative shrink-0 rounded overflow-hidden ${active ? "ring-2 ring-accent-500" : "ring-1 ring-black/10 dark:ring-white/10"} ${over ? "outline outline-2 outline-accent-500/60" : ""}`}
      style={{ width, height }}
    >
      {seen && <SlideFrame dir={dir} name={name} size={size} box={{ width, height }} />}
      <span className="absolute bottom-0.5 left-1 text-[10px] text-gray-500">{index + 1}</span>
    </button>
  );
}
