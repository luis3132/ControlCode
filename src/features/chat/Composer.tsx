import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AddIcon, Button, ChevronDownIcon, CloseIcon, Dropdown, Kbd, Tooltip, type DropdownItem,
} from "neogestify-ui-components";
import { useShallow } from "zustand/react/shallow";

import { dropText } from "@/features/explorer/paths";
import type { Tab } from "@/features/tabs/types";

import { registerComposer } from "./bridge";
import { agentEfforts, chatModels } from "./ipc";

import { modelChoices, modelLabel, modelShownAs, slashAction, slashMenu, slashQuery, type BuiltinCommand } from "./message";
import { loadCommands, loadSeenModels } from "./prefs";
import { useChatStore } from "./store";
import { EFFORTS, type Effort, type ImageAttachment, type PermissionMode } from "./types";

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

/** Una imagen del portapapeles (o soltada), lista para la API. */
function readImage(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ name: file.name || "imagen", mediaType: file.type, data: url.slice(url.indexOf(",") + 1) });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Lo que reemplaza a la entrada de la TUI: un input que crece, el menú de `/` y, abajo, los
 * comandos que en la TUI se escriben y acá son componentes (modelo, modo de permisos,
 * compactar, conversación nueva).
 *
 * Enter manda y Shift+Enter baja de línea. Mientras el agente trabaja, lo que se manda
 * queda en cola y sale cuando termina; Detener corta el turno.
 */
export function Composer({ tab, isActive }: { tab: Tab; isActive: boolean }) {
  const { t } = useTranslation();
  const tabId = tab.id;
  // Solo lo que el input usa, comparado campo por campo: suscripto al estado entero, se
  // redibujaba (menús incluidos) con cada pedacito de texto que escribía el agente.
  const fallback = useRef(useChatStore.getState().get(tabId)).current;
  const c = useChatStore(useShallow((s) => {
    const cur = s.chats[tabId] ?? fallback;
    return {
      info: cur.chat.info, draft: cur.draft, effort: cur.effort, images: cur.images, mode: cur.mode,
      model: cur.model, queue: cur.queue, running: cur.running, starting: cur.starting,
    };
  }));
  const store = useChatStore.getState();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [modelOpen, setModelOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  // Los niveles los dice la TUI instalada (`--help`), no una lista de acá: cambian con su
  // versión, y con el modelo la CLI ajusta sola el que no corresponda.
  const [efforts, setEfforts] = useState<Effort[]>([]);
  const busy = c.running || c.starting;

  useEffect(() => (ref.current ? registerComposer(tabId, ref.current) : undefined), [tabId]);
  // Crece con lo escrito hasta el tope del CSS. Se vuelve a medir también al activarse la
  // tab: estando oculta, `scrollHeight` es 0 y la medida no sirve.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight > 0 ? `${el.scrollHeight}px` : "";
  }, [c.draft, isActive]);
  useEffect(() => {
    if (isActive) ref.current?.focus();
  }, [isActive]);
  // El latido al cambiar de esfuerzo: se enciende con el cambio y se apaga solo. Ver
  // `cc-effort-pulse` en `App.css`.
  const [pulse, setPulse] = useState(false);
  const firstEffort = useRef(true);
  useEffect(() => {
    if (firstEffort.current) {
      // Al abrir la tab no late: eso no es un cambio, es lo que ya estaba elegido.
      firstEffort.current = false;
      return;
    }
    if (!c.effort) return;
    setPulse(true);
    // Tres latidos: el tope sale del ritmo del nivel, así el lento no se corta a la mitad.
    const beat = Number.parseInt(EFFORT_TONE[c.effort].beat, 10) || 620;
    const id = window.setTimeout(() => setPulse(false), beat * 3 + 150);
    return () => window.clearTimeout(id);
  }, [c.effort]);

  useEffect(() => {
    let stale = false;
    agentEfforts(tab.agentId)
      .then((levels) => {
        if (!stale) setEfforts(levels.filter((l): l is Effort => (EFFORTS as string[]).includes(l)));
      })
      .catch(console.error);
    return () => { stale = true; };
  }, [tab.agentId]);

  // Los comandos del agente: los del último arranque de esta tab o, antes del primero, los
  // que se vieron en esta carpeta.
  const commands = useMemo(() => {
    if (c.info) return { slash: c.info.slashCommands, terminal: c.info.terminalCommands };
    return loadCommands(tab.cwd);
  }, [c.info, tab.cwd]);

  const query = slashQuery(c.draft);
  const menu = useMemo(
    () => (query === null ? [] : slashMenu(query, commands.slash, commands.terminal).slice(0, 12)),
    [query, commands]
  );
  useEffect(() => setMenuIndex(0), [query]);

  const runBuiltin = (name: BuiltinCommand, args: string) => {
    if (name === "btw" && !args) {
      // Sin pregunta no hay nada al margen que preguntar: se deja escrito para seguir.
      store.setDraft(tabId, "/btw ");
      ref.current?.focus();
      return;
    }
    store.setDraft(tabId, "");
    if (name === "clear") void store.newConversation(tabId);
    else if (name === "compact") store.send(tabId, { text: args ? `/compact ${args}` : "/compact", images: [] });
    else if (name === "btw") store.askSide(tabId, args);
    else if (name === "model") {
      // Cualquier nombre vale: `--model` acepta los alias y los nombres completos, así que
      // un modelo que la app no conoce igual se puede usar.
      if (args) store.setModel(tabId, args === "default" ? null : args);
      else setModelOpen(true);
    } else if (name === "effort") {
      if (args) {
        const level = args.toLowerCase();
        if (level === "default") store.setEffort(tabId, null);
        else if ((efforts as string[]).includes(level)) store.setEffort(tabId, level as Effort);
        else store.notice(tabId, "info", t("chat.effort.unknown", { level: args, levels: efforts.join(", ") }));
      } else setEffortOpen(true);
    } else if (name === "mode") setModeOpen(true);
  };

  const submit = () => {
    const text = c.draft;
    if (!text.trim() && c.images.length === 0) return;
    const action = slashAction(text, commands.terminal);
    if (action.kind === "builtin") return runBuiltin(action.name, action.args);
    if (action.kind === "terminalOnly") {
      store.notice(tabId, "info", t("chat.terminalOnly", { name: action.name }));
      return;
    }
    store.send(tabId, { text, images: c.images });
    store.setDraft(tabId, "");
    for (let i = c.images.length - 1; i >= 0; i--) store.removeImage(tabId, i);
  };

  const pick = (name: string, builtin: boolean) => {
    if (builtin) return runBuiltin(name as BuiltinCommand, "");
    // Uno del agente se escribe para que la persona le agregue argumentos.
    store.setDraft(tabId, `/${name} `);
    ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (menu.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMenuIndex((i) => (i + 1) % menu.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setMenuIndex((i) => (i - 1 + menu.length) % menu.length); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const entry = menu[menuIndex]!;
        pick(entry.name, entry.builtin);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); store.setDraft(tabId, ""); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape" && busy) {
      e.preventDefault();
      void store.stop(tabId);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    Promise.all(files.map(readImage)).then((imgs) => store.addImages(tabId, imgs)).catch(console.error);
  };

  const attach = async () => {
    const picked = await openDialog({ multiple: true, defaultPath: tab.cwd }).catch(() => null);
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length === 0) return;
    const text = dropText(paths.map((path) => ({ path, isDir: false })), tab.cwd, false);
    if (!text) return;
    store.setDraft(tabId, c.draft && !/\s$/.test(c.draft) ? `${c.draft} ${text}` : `${c.draft}${text}`);
    ref.current?.focus();
  };

  // La lista sale del catálogo de la CLI instalada y de lo que se vio correr: un modelo
  // nuevo aparece solo, con su versión, sin tocar código. Ver `modelChoices`.
  const [known, setKnown] = useState<{ id: string; name: string | null }[]>([]);
  useEffect(() => {
    let stale = false;
    chatModels(tab.accountId ?? null)
      .then((list) => { if (!stale) setKnown(list); })
      .catch(console.error);
    return () => { stale = true; };
  }, [tab.accountId]);
  const models = useMemo(
    () => modelChoices(known, loadSeenModels(tab.cwd)),
    // `c.info`: al llegar el `init` puede haber aparecido un modelo nuevo en la lista.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [known, tab.cwd, c.info]
  );
  const modelItems: DropdownItem[] = [
    { id: "", label: twoLines(t("chat.model.default"), t("chat.model.defaultHint")), onSelect: () => store.setModel(tabId, null) },
    ...models.map((m) => ({
      id: m.id,
      label: m.label,
      onSelect: () => store.setModel(tabId, m.id),
    })),
    {
      id: "__other",
      label: twoLines(t("chat.model.other"), t("chat.model.otherHint")),
      separatorBefore: true,
      onSelect: () => {
        store.setDraft(tabId, "/model ");
        ref.current?.focus();
      },
    },
  ];
  const effortItems: DropdownItem[] = [
    { id: "", label: t("chat.effort.default"), onSelect: () => store.setEffort(tabId, null) },
    ...efforts.map((level) => ({
      id: level,
      label: twoLines(t(`chat.effort.${level}`), t(`chat.effort.${level}Desc`)),
      onSelect: () => store.setEffort(tabId, level),
    })),
  ];
  const modeItems: DropdownItem[] = MODES.map((mode) => ({
    id: mode,
    label: (
      <span className="flex flex-col whitespace-normal">
        <span>{t(`chat.mode.${mode}`)}</span>
        <span className="text-[10.5px] opacity-60">{t(`chat.mode.${mode}Desc`)}</span>
      </span>
    ),
    danger: mode === "bypassPermissions",
    separatorBefore: mode === "bypassPermissions",
    onSelect: () => store.setMode(tabId, mode),
  }));
  const modelShown = c.model
    ? modelShownAs(c.model, models)
    : modelLabel(c.info?.model ?? null) ?? t("chat.model.label");

  // Nombre corto arriba y para qué sirve abajo, como el menú de modos: "Resumir la
  // conversación para liberar contexto" como etiqueta es una frase, no una opción.
  const moreItems: DropdownItem[] = [
    { id: "btw", label: twoLines(t("chat.btw"), t("chat.cmd.btw")), onSelect: () => runBuiltin("btw", "") },
    { id: "compact", label: twoLines(t("chat.compact"), t("chat.cmd.compact")), onSelect: () => runBuiltin("compact", "") },
    { id: "clear", label: twoLines(t("chat.newConversation"), t("chat.cmd.clear")), onSelect: () => runBuiltin("clear", "") },
  ];

  // Los controles de abajo del input son del MISMO rango que el input: no son botones de
  // acción, son el estado con el que se va a mandar (modelo, modo) y lo que se puede
  // agregar. Por eso van planos, sin borde ni fondo propio, y solo se dibujan al pasarles
  // por encima. Lo único con peso visual es mandar, que es la acción.
  const chip = `cc-t h-7 px-2 rounded-lg text-[11.5px] font-medium flex items-center gap-1.5
    text-gray-600 dark:text-white/55
    hover:bg-gray-100 dark:hover:bg-white/[0.07] hover:text-gray-900 dark:hover:text-white`;
  const iconBtn = `cc-t w-7 h-7 rounded-lg flex items-center justify-center shrink-0
    text-gray-500 dark:text-white/50
    hover:bg-gray-100 dark:hover:bg-white/[0.07] hover:text-gray-900 dark:hover:text-white`;
  const canSend = c.draft.trim().length > 0 || c.images.length > 0;
  const tone = c.effort ? EFFORT_TONE[c.effort] : null;

  return (
    <div className="shrink-0 bg-white dark:bg-[#0d1117]">
      <div className="relative w-full px-5 lg:px-8 pt-1 pb-3 flex flex-col gap-1.5">
        {menu.length > 0 && (
          <div role="listbox" className="absolute left-5 lg:left-8 right-5 lg:right-8 max-w-md bottom-full mb-1 z-20 max-h-72 overflow-y-auto
            rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#161b22] shadow-xl py-1">
            {menu.map((entry, i) => (
              <Button key={entry.name} variant="custom" role="option" aria-selected={i === menuIndex}
                onMouseEnter={() => setMenuIndex(i)}
                onClick={() => pick(entry.name, entry.builtin)}
                className={`w-full flex items-center gap-2 px-3 h-8 text-left text-[12px]
                  ${i === menuIndex ? "bg-blue-50 dark:bg-blue-500/15" : ""}`}>
                <span className="font-mono text-gray-800 dark:text-gray-100">/{entry.name}</span>
                <span className="truncate text-[11px] text-gray-400 dark:text-white/35">
                  {entry.builtin ? t(`chat.cmd.${entry.name}`) : t("chat.cmd.agent")}
                </span>
              </Button>
            ))}
          </div>
        )}

        {c.queue.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {c.queue.map((q, i) => (
              <span key={i} className="flex items-center gap-1 max-w-full pl-2 pr-1 h-6 rounded-md text-[11px]
                bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                <span className="shrink-0 opacity-70">{t("chat.queued")}</span>
                <span className="truncate">{q.text || t("chat.imageOnly")}</span>
                <Button variant="icon" onClick={() => store.dropQueued(tabId, i)} aria-label={t("btn.delete")}
                  className="w-4 h-4 p-0 flex items-center justify-center">
                  <CloseIcon className="w-3 h-3" />
                </Button>
              </span>
            ))}
          </div>
        )}

        {c.images.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {c.images.map((img, i) => (
              <div key={i} className="relative">
                <img src={`data:${img.mediaType};base64,${img.data}`} alt={img.name}
                  className="h-14 w-14 object-cover rounded-md border border-gray-200 dark:border-white/10" />
                <Button variant="icon" onClick={() => store.removeImage(tabId, i)} aria-label={t("btn.delete")}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 p-0 rounded-full flex items-center justify-center
                    bg-gray-800 text-white">
                  <CloseIcon className="w-2.5 h-2.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div
          style={tone ? ({ "--cc-effort-glow": tone.glow, "--cc-effort-beat": tone.beat } as React.CSSProperties) : undefined}
          className={`flex flex-col rounded-2xl border transition-colors
            bg-white dark:bg-white/[0.03]
            ${tone ? tone.border : "border-gray-200 dark:border-white/10"}
            ${tone ? "" : "focus-within:border-blue-400 dark:focus-within:border-blue-500/60"}
            ${pulse ? "cc-effort-pulse" : ""}
            shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:shadow-none`}>
          {/* Un `textarea` pelado y no el de la librería: sus variantes traen borde propio
              (la "minimal" es un subrayado) y acá el borde ya lo pone la tarjeta, así que
              adentro quedaba una línea de más. El autoajuste se hace acá al lado por el
              mismo motivo por el que hay un alto mínimo: si se mide mientras el panel está
              oculto, `scrollHeight` da 0 y el input se cerraba a una raya. */}
          <textarea
            ref={ref}
            value={c.draft}
            onChange={(e) => store.setDraft(tabId, e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={busy ? t("chat.placeholderBusy") : t("chat.placeholder")}
            rows={1}
            className="w-full min-h-[2.5rem] max-h-60 resize-none overflow-y-auto bg-transparent
              px-3.5 pt-3 pb-1 text-[13.5px] leading-[1.6] outline-none
              text-gray-900 dark:text-gray-100
              placeholder:text-gray-400 dark:placeholder:text-white/30"
          />

          {/* Envuelve: el panel de una tab puede ser angosto aunque la ventana no lo sea,
              y una fila que no envuelve se le sale por la derecha. */}
          <div className="flex flex-wrap items-center gap-0.5 px-2 pb-2">
            <Tooltip content={t("chat.attach")}>
              <Button variant="custom" onClick={() => void attach()} aria-label={t("chat.attach")} className={iconBtn}>
                <AddIcon className="w-4 h-4" />
              </Button>
            </Tooltip>
            <Dropdown open={modelOpen} onOpenChange={setModelOpen} items={modelItems} placement="top-start"
              aria-label={t("chat.model.label")}
              trigger={
                <Button variant="custom" className={`${chip} max-w-44`}>
                  <span className="truncate">{modelShown}</span>
                  <ChevronDownIcon className="w-3 h-3 opacity-50" />
                </Button>
              } />
            {efforts.length > 0 && (
            <Dropdown open={effortOpen} onOpenChange={setEffortOpen} items={effortItems} placement="top-start" minWidth={260}
              aria-label={t("chat.effort.label")}
              trigger={
                <Button variant="custom" className={chip}>
                  {/* Con el de fábrica alcanza con nombrar el control: "Esfuerzo de
                      fábrica" ocupa el doble y dice lo mismo que no haber elegido. */}
                  <span className={tone ? tone.text : undefined}>
                    {c.effort ? t(`chat.effort.${c.effort}`) : t("chat.effort.label")}
                  </span>
                  <ChevronDownIcon className="w-3 h-3 opacity-50" />
                </Button>
              } />
            )}
            <Dropdown open={modeOpen} onOpenChange={setModeOpen} items={modeItems} placement="top-start" minWidth={320}
              aria-label={t("chat.mode.label")}
              trigger={
                <Button variant="custom" className={`${chip} max-w-44 ${MODE_TONE[c.mode]}`}>
                  <span className="truncate">{t(`chat.mode.${c.mode}`)}</span>
                  <ChevronDownIcon className="w-3 h-3 opacity-50" />
                </Button>
              } />
            {/* Compactar y empezar de nuevo son de una vez cada muchas: ocupando lugar fijo
                le ganaban el espacio al modelo y al modo, que son los que se miran siempre. */}
            <Dropdown open={moreOpen} onOpenChange={setMoreOpen} items={moreItems} placement="top-start"
              aria-label={t("chat.more")}
              trigger={
                <Button variant="custom" aria-label={t("chat.more")} className={iconBtn}>
                  <MoreDots />
                </Button>
              } />

            <span className="flex-1" />

            <span className="hidden sm:flex items-center gap-1 mr-1 text-[10.5px] text-gray-400 dark:text-white/30">
              <Kbd>/</Kbd> {t("chat.hintCommands")}
            </span>

            {busy ? (
              <Tooltip content={t("chat.stop")}>
                <Button variant="custom" onClick={() => void store.stop(tabId)} aria-label={t("chat.stop")}
                  className="cc-t w-8 h-8 rounded-full flex items-center justify-center shrink-0
                    bg-gray-900 text-white hover:bg-gray-700
                    dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">
                  <span className="w-2.5 h-2.5 rounded-[2px] bg-current" />
                </Button>
              </Tooltip>
            ) : (
              <Button variant="custom" onClick={submit} disabled={!canSend} aria-label={t("chat.send")}
                className="cc-t w-8 h-8 rounded-full flex items-center justify-center shrink-0
                  bg-blue-600 text-white hover:bg-blue-700
                  disabled:bg-gray-100 disabled:text-gray-400 disabled:hover:bg-gray-100
                  dark:disabled:bg-white/[0.08] dark:disabled:text-white/25 dark:disabled:hover:bg-white/[0.08]">
                <SendArrow />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** La flecha de mandar. */
function SendArrow() {
  return (
    <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 13V3.5" />
      <path d="M3.75 7.75 8 3.5l4.25 4.25" />
    </svg>
  );
}

/** Los tres puntos de "más acciones". */
function MoreDots() {
  return (
    <svg viewBox="0 0 16 16" className="w-4 h-4" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="12.5" cy="8" r="1.3" />
    </svg>
  );
}

/** Una opción de menú con su nombre y, debajo, qué hace. */
function twoLines(name: string, hint: string) {
  return (
    <span className="flex flex-col whitespace-normal">
      <span>{name}</span>
      <span className="text-[10.5px] opacity-60">{hint}</span>
    </span>
  );
}

/**
 * El color de cada esfuerzo: de lo frío y barato a lo caliente y caro.
 *
 * No es decoración: un esfuerzo alto cuesta tokens y tiempo, y la barra de escribir es el
 * único lugar donde se va a notar antes de mandar. La escala va subiendo de temperatura
 * justamente para que "max" no se vea igual que "bajo" de reojo.
 */
const EFFORT_TONE: Record<Effort, { border: string; text: string; glow: string; beat: string }> = {
  low: {
    beat: "1100ms",
    border: "border-slate-300 dark:border-slate-400/35",
    text: "text-slate-600 dark:text-slate-300",
    glow: "rgba(148, 163, 184, 0.35)",
  },
  medium: {
    beat: "850ms",
    border: "border-sky-400/80 dark:border-sky-400/40",
    text: "text-sky-700 dark:text-sky-300",
    glow: "rgba(56, 189, 248, 0.35)",
  },
  high: {
    beat: "650ms",
    border: "border-amber-400/80 dark:border-amber-400/45",
    text: "text-amber-700 dark:text-amber-300",
    glow: "rgba(251, 191, 36, 0.38)",
  },
  xhigh: {
    beat: "480ms",
    border: "border-violet-400/80 dark:border-violet-400/50",
    text: "text-violet-700 dark:text-violet-300",
    glow: "rgba(167, 139, 250, 0.45)",
  },
  max: {
    beat: "340ms",
    border: "border-fuchsia-500/80 dark:border-fuchsia-400/55",
    text: "text-fuchsia-700 dark:text-fuchsia-300",
    glow: "rgba(232, 121, 249, 0.5)",
  },
};

/**
 * El color de cada modo de permisos, con el mismo código que usa la TUI: plan en azul,
 * aceptar ediciones en dorado, sin permisos en rojo.
 *
 * El modo cambia lo que el agente puede hacer SIN preguntar, así que es lo que más
 * conviene reconocer de reojo antes de mandar; "Preguntar" queda neutro porque es el que
 * no necesita aviso.
 */
const MODE_TONE: Record<PermissionMode, string> = {
  default: "",
  plan: "text-sky-600 dark:text-sky-400",
  acceptEdits: "text-amber-600 dark:text-amber-400",
  bypassPermissions: "text-red-600 dark:text-red-400",
};
