import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, CloseIcon, TrashIcon } from "neogestify-ui-components";

import { ArrowToolIcon, HighlighterIcon, PenIcon, RectToolIcon, RedoIcon, TextToolIcon, UndoIcon } from "@/app/icons";

import { ToolbarSeparator, ToolButton } from "../toolbarButtons";
import type { FrozenPage } from "./capture";
import { placePaper, toImagePoint, type Point, type Size } from "./geometry";
import {
  addShape, clearShapes, COLORS, drawShape, EMPTY_HISTORY, isEmptyShape, redo, STROKE_WIDTH, TEXT_SIZE, textFont,
  undo, type History, type Shape, type StrokeSize, type Tool,
} from "./shapes";

/**
 * El lienzo para anotar sobre la página congelada, como sobre un papel: lápiz, resaltador,
 * flechas, rectángulos y texto encima de la foto de lo que se estaba viendo.
 *
 * Son dos piezas en dos lugares de la tab —la barra de herramientas reemplaza a la del
 * navegador; el lienzo tapa la página— que comparten una sesión.
 */

export interface AnnotationSession {
  tool: Tool;
  setTool: (tool: Tool) => void;
  color: string;
  setColor: (color: string) => void;
  size: StrokeSize;
  setSize: (size: StrokeSize) => void;
  history: History;
  add: (shape: Shape) => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
  /** Lienzo en blanco para una captura nueva. Herramienta, color y grosor se recuerdan. */
  reset: () => void;
}

export function useAnnotationSession(): AnnotationSession {
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState<string>(COLORS[0].value);
  const [size, setSize] = useState<StrokeSize>("medium");
  const [history, setHistory] = useState<History>(EMPTY_HISTORY);
  return {
    tool, setTool, color, setColor, size, setSize, history,
    add: useCallback((shape: Shape) => setHistory((h) => addShape(h, shape)), []),
    undo: useCallback(() => setHistory(undo), []),
    redo: useCallback(() => setHistory(redo), []),
    clear: useCallback(() => setHistory(clearShapes), []),
    reset: useCallback(() => setHistory(EMPTY_HISTORY), []),
  };
}

/** La página congelada con lo dibujado encima, a la resolución de la captura. */
export function renderAnnotated(page: HTMLCanvasElement, shapes: Shape[]): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = page.width;
  out.height = page.height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("no hay canvas 2D");
  ctx.drawImage(page, 0, 0);
  for (const shape of shapes) drawShape(ctx, shape);
  return out;
}

const TOOLS: { id: Tool; icon: (p: { className?: string }) => React.ReactNode }[] = [
  { id: "pen", icon: PenIcon },
  { id: "marker", icon: HighlighterIcon },
  { id: "arrow", icon: ArrowToolIcon },
  { id: "rect", icon: RectToolIcon },
  { id: "text", icon: TextToolIcon },
];

const SIZES: StrokeSize[] = ["thin", "medium", "thick"];

export function AnnotationBar({ session, compact, busy, onCancel, onDone }: {
  session: AnnotationSession;
  compact: boolean;
  busy: boolean;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { history } = session;

  return (
    <div className="flex items-center gap-2 h-11 shrink-0 px-2 border-b border-gray-200 dark:border-white/7">
      <div className="cc-scroll-x flex items-center gap-1 flex-1 min-w-0">
        {!compact && (
          <span className="shrink-0 mr-1 px-2 h-6 rounded-full flex items-center text-[11px] font-semibold
            bg-blue-500/12 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300">
            {t("browser.annotate.frozen")}
          </span>
        )}
        {TOOLS.map(({ id, icon: Icon }) => (
          <ToolButton key={id} label={t(`browser.annotate.tool.${id}`)} active={session.tool === id} onClick={() => session.setTool(id)}>
            <Icon className="w-4 h-4" />
          </ToolButton>
        ))}
        <ToolbarSeparator />
        {compact ? (
          <>
            <ColorMenu session={session} />
            {/* Uno solo que va rotando: los tres juntos no entran al lado de todo lo demás. */}
            <SizeButton
              size={session.size}
              label={t(`browser.annotate.size.${session.size}`)}
              onClick={() => session.setSize(SIZES[(SIZES.indexOf(session.size) + 1) % SIZES.length]!)}
            />
          </>
        ) : (
          <>
            {COLORS.map(({ id, value }) => (
              <ColorSwatch key={id} id={id} value={value} selected={session.color === value} onSelect={() => session.setColor(value)} />
            ))}
            <ToolbarSeparator />
            {SIZES.map((size) => (
              <SizeButton key={size} size={size} label={t(`browser.annotate.size.${size}`)} selected={session.size === size}
                onClick={() => session.setSize(size)} />
            ))}
          </>
        )}
        <ToolbarSeparator />
        <ToolButton label={t("browser.annotate.undo")} disabled={history.past.length === 0} onClick={session.undo}>
          <UndoIcon className="w-4 h-4" />
        </ToolButton>
        <ToolButton label={t("browser.annotate.redo")} disabled={history.future.length === 0} onClick={session.redo}>
          <RedoIcon className="w-4 h-4" />
        </ToolButton>
        <ToolButton label={t("browser.annotate.clear")} disabled={history.present.length === 0} onClick={session.clear}>
          <TrashIcon className="w-4 h-4" />
        </ToolButton>
      </div>
      {compact ? (
        <ToolButton label={t("browser.annotate.cancel")} onClick={onCancel}>
          <CloseIcon className="w-4 h-4" />
        </ToolButton>
      ) : (
        <Button size="sm" variant="outline" onClick={onCancel}>{t("browser.annotate.cancel")}</Button>
      )}
      <Button size="sm" variant="primary" onClick={onDone} disabled={busy}>
        {busy ? t("browser.annotate.saving") : t("browser.annotate.done")}
      </Button>
    </div>
  );
}

function ColorSwatch({ id, value, selected, onSelect }: {
  id: string;
  value: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const label = t(`browser.annotate.color.${id}`);
  return (
    <button
      onClick={onSelect}
      aria-label={label}
      aria-pressed={selected}
      title={label}
      className={`cc-t flex items-center justify-center w-7 h-7 shrink-0 rounded-full
        ${selected ? "ring-2 ring-blue-500 dark:ring-blue-400" : "hover:bg-gray-200 dark:hover:bg-white/10"}`}
    >
      <span className="w-4 h-4 rounded-full border border-black/20 dark:border-white/25" style={{ background: value }} />
    </button>
  );
}

function SizeButton({ size, label, selected, onClick }: {
  size: StrokeSize;
  label: string;
  selected?: boolean;
  onClick: () => void;
}) {
  const dot = 3 + SIZES.indexOf(size) * 3;
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={selected}
      title={label}
      className={`cc-t flex items-center justify-center w-7 h-7 shrink-0 rounded-lg
        ${selected ? "bg-blue-500/15 dark:bg-blue-400/20" : "hover:bg-gray-200 dark:hover:bg-white/10"}`}
    >
      <span className="rounded-full bg-gray-700 dark:bg-gray-200" style={{ width: dot, height: dot }} />
    </button>
  );
}

/** El color elegido, que despliega los demás. Para cuando la barra es angosta. */
function ColorMenu({ session }: { session: AnnotationSession }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = COLORS.find((c) => c.value === session.color) ?? COLORS[0];

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close, { capture: true });
    return () => window.removeEventListener("pointerdown", close, { capture: true });
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <ColorSwatch id={current.id} value={current.value} selected={open} onSelect={() => setOpen((v) => !v)} />
      {open && (
        // `fixed` y no `absolute`: la tira de herramientas scrollea en horizontal y recortaría el menú.
        <ColorPopover anchor={ref.current} label={t("browser.annotate.color")}>
          {COLORS.map(({ id, value }) => (
            <ColorSwatch key={id} id={id} value={value} selected={session.color === value}
              onSelect={() => { session.setColor(value); setOpen(false); }} />
          ))}
        </ColorPopover>
      )}
    </div>
  );
}

function ColorPopover({ anchor, label, children }: { anchor: HTMLElement | null; label: string; children: React.ReactNode }) {
  const box = anchor?.getBoundingClientRect();
  if (!box) return null;
  return (
    <div
      role="group"
      aria-label={label}
      className="fixed z-50 flex items-center gap-1 p-1.5 rounded-xl shadow-lg
        bg-white dark:bg-[#161b22] border border-gray-200 dark:border-white/10"
      style={{ left: box.left, top: box.bottom + 6 }}
    >
      {children}
    </div>
  );
}

interface TextDraft {
  at: Point;
  text: string;
}

/**
 * La página congelada, tapando la columna del navegador, con los lienzos encima.
 *
 * Dos lienzos: abajo la foto con lo ya dibujado, que se repinta solo al agregar o deshacer;
 * arriba el trazo en curso, que se repinta con cada movimiento. Repintar la foto entera por
 * cada evento del puntero se nota en una captura grande.
 */
export function AnnotationCanvas({ frozen, session, active, onCancel }: {
  frozen: FrozenPage;
  session: AnnotationSession;
  /** Si esta tab tiene el foco: los atajos de teclado son solo para ella. */
  active: boolean;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const layer = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const live = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<Shape | null>(null);
  const [column, setColumn] = useState<Size | null>(null);
  const [draft, setDraft] = useState<TextDraft | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const image = { width: frozen.canvas.width, height: frozen.canvas.height };
  /** Los grosores se eligen en px de pantalla; lo dibujado vive en píxeles de la captura. */
  const pxPerCss = image.width / frozen.screen.width;

  useLayoutEffect(() => {
    const el = layer.current;
    if (!el) return;
    const measure = () => setColumn({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const paper = column ? placePaper(frozen.screen, frozen.offset, column) : null;
  // Transparente solo si todo sigue donde estaba: alrededor de la foto se ve lo mismo que
  // cuando se sacó (el fondo de un tamaño de dispositivo). Si la columna cambió, abajo puede
  // asomar la página viva, y se tapa.
  const inPlace = paper !== null && column !== null
    && paper.left === frozen.offset.x && paper.top === frozen.offset.y
    && Math.abs(column.width - frozen.column.width) < 1 && Math.abs(column.height - frozen.column.height) < 1;
  const hasPaper = paper !== null;

  useLayoutEffect(() => {
    const ctx = base.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, frozen.canvas.width, frozen.canvas.height);
    ctx.drawImage(frozen.canvas, 0, 0);
    for (const shape of session.history.present) drawShape(ctx, shape);
    // Lo que se acaba de soltar ya quedó abajo: recién ahora se borra de arriba, en el mismo
    // cuadro, para que no parpadee.
    live.current?.getContext("2d")?.clearRect(0, 0, frozen.canvas.width, frozen.canvas.height);
  }, [frozen, session.history.present, hasPaper]);

  // El foco sale del `<iframe>`: si no, las teclas le siguen llegando a la página de abajo.
  useEffect(() => {
    layer.current?.focus();
  }, []);

  const commitDraft = useCallback(() => {
    const current = draftRef.current;
    if (!current) return;
    // Click afuera y blur llegan juntos: el segundo no puede volver a agregar el mismo texto.
    draftRef.current = null;
    const { color, size } = sessionRef.current;
    sessionRef.current.add({ kind: "text", color, size: TEXT_SIZE[size] * pxPerCss, at: current.at, text: current.text });
    setDraft(null);
  }, [pxPerCss]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      // El texto que se está escribiendo maneja sus propias teclas.
      if (draftRef.current) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (e.key === "Escape") onCancel();
      else if (mod && key === "z") (e.shiftKey ? sessionRef.current.redo : sessionRef.current.undo)();
      else if (mod && key === "y") sessionRef.current.redo();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [active, onCancel]);

  const pointOf = (e: { clientX: number; clientY: number }): Point => {
    const r = live.current!.getBoundingClientRect();
    return toImagePoint({ x: e.clientX, y: e.clientY }, { left: r.left, top: r.top, width: r.width, height: r.height }, image);
  };

  const paintLive = () => {
    const ctx = live.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, image.width, image.height);
    if (drawing.current) drawShape(ctx, drawing.current);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (draftRef.current) {
      commitDraft();
      return;
    }
    const at = pointOf(e);
    const { tool, color, size } = sessionRef.current;
    if (tool === "text") {
      setDraft({ at, text: "" });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const width = STROKE_WIDTH[size] * pxPerCss;
    drawing.current = tool === "pen" || tool === "marker"
      ? { kind: tool, color, width, points: [at] }
      : { kind: tool, color, width, from: at, to: at };
    paintLive();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const shape = drawing.current;
    if (!shape) return;
    if (shape.kind === "pen" || shape.kind === "marker") {
      // Los eventos que el navegador juntó en uno: sin ellos un trazo rápido sale en rectas.
      const native = e.nativeEvent;
      const events = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
      for (const ev of events.length > 0 ? events : [native]) shape.points.push(pointOf(ev));
    } else if (shape.kind === "arrow" || shape.kind === "rect") {
      shape.to = pointOf(e);
    }
    paintLive();
  };

  const onPointerUp = () => {
    const shape = drawing.current;
    drawing.current = null;
    if (!shape) return;
    if (isEmptyShape(shape)) paintLive();
    else sessionRef.current.add(shape);
  };

  const displayScale = paper ? paper.width / frozen.screen.width : 1;
  const draftFont = TEXT_SIZE[session.size] * displayScale;

  return (
    <div
      ref={layer}
      tabIndex={-1}
      className={`absolute inset-0 z-30 overflow-hidden outline-none select-none
        ${inPlace ? "" : "bg-gray-100 dark:bg-[#0b0f14]"}`}
    >
      {paper && (
        <div
          className="absolute ring-1 ring-blue-500/60"
          style={{ left: paper.left, top: paper.top, width: paper.width, height: paper.height }}
        >
          <canvas ref={base} width={image.width} height={image.height} className="absolute inset-0 w-full h-full" />
          <canvas
            ref={live}
            width={image.width}
            height={image.height}
            className="absolute inset-0 w-full h-full touch-none"
            style={{ cursor: session.tool === "text" ? "text" : "crosshair" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {draft && (
            <textarea
              autoFocus
              value={draft.text}
              placeholder={t("browser.annotate.textPlaceholder")}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              onBlur={commitDraft}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setDraft(null);
                } else if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  commitDraft();
                }
              }}
              rows={Math.max(1, draft.text.split("\n").length)}
              spellCheck={false}
              className="absolute m-0 p-0 border-0 bg-transparent resize-none overflow-hidden
                outline-1 outline-dashed outline-offset-2 outline-blue-500 placeholder:text-current placeholder:opacity-50"
              style={{
                left: (draft.at.x / image.width) * paper.width,
                // El texto del lienzo se apoya en el borde de arriba de la letra; el del
                // `<textarea>`, en su renglón. La diferencia es medio interlineado.
                top: (draft.at.y / image.height) * paper.height - draftFont * 0.125,
                width: `${Math.max(6, ...draft.text.split("\n").map((l) => l.length + 2))}ch`,
                font: textFont(draftFont),
                lineHeight: 1.25,
                color: session.color,
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
