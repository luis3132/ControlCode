import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AddIcon, Button, CloseIcon, Dropdown, Kbd, TextArea, Tooltip, type DropdownItem,
} from "neogestify-ui-components";

import { dropText } from "@/features/explorer/paths";
import type { Tab } from "@/features/tabs/types";

import { registerComposer } from "./bridge";
import { CLAUDE_MODEL_ALIASES, modelLabel, slashAction, slashMenu, slashQuery, type BuiltinCommand } from "./message";
import { loadCommands } from "./prefs";
import { useChatStore } from "./store";
import type { ImageAttachment, PermissionMode } from "./types";

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
  const c = useChatStore((s) => s.chats[tabId]) ?? useChatStore.getState().get(tabId);
  const store = useChatStore.getState();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [modelOpen, setModelOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const busy = c.running || c.starting;

  useEffect(() => (ref.current ? registerComposer(tabId, ref.current) : undefined), [tabId]);
  useEffect(() => {
    if (isActive) ref.current?.focus();
  }, [isActive]);

  // Los comandos del agente: los del último arranque de esta tab o, antes del primero, los
  // que se vieron en esta carpeta.
  const commands = useMemo(() => {
    if (c.chat.info) return { slash: c.chat.info.slashCommands, terminal: c.chat.info.terminalCommands };
    return loadCommands(tab.cwd);
  }, [c.chat.info, tab.cwd]);

  const query = slashQuery(c.draft);
  const menu = useMemo(
    () => (query === null ? [] : slashMenu(query, commands.slash, commands.terminal).slice(0, 12)),
    [query, commands]
  );
  useEffect(() => setMenuIndex(0), [query]);

  const runBuiltin = (name: BuiltinCommand, args: string) => {
    store.setDraft(tabId, "");
    if (name === "clear") void store.newConversation(tabId);
    else if (name === "compact") store.send(tabId, { text: args ? `/compact ${args}` : "/compact", images: [] });
    else if (name === "model") {
      if (args) store.setModel(tabId, args === "default" ? null : args);
      else setModelOpen(true);
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

  const modelItems: DropdownItem[] = [
    { id: "", label: t("chat.model.default"), onSelect: () => store.setModel(tabId, null) },
    ...CLAUDE_MODEL_ALIASES.map((m) => ({ id: m.id, label: m.label, onSelect: () => store.setModel(tabId, m.id) })),
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
    ? CLAUDE_MODEL_ALIASES.find((m) => m.id === c.model)?.label ?? c.model
    : modelLabel(c.chat.info?.model ?? null) ?? t("chat.model.default");

  const chip = `cc-t h-6 px-2 rounded-md text-[11px] flex items-center gap-1 text-gray-600 dark:text-white/60
    hover:bg-gray-100 dark:hover:bg-white/8 hover:text-gray-900 dark:hover:text-white`;

  return (
    <div className="shrink-0 border-t border-gray-200 dark:border-white/8 bg-white dark:bg-[#0d1117]">
      <div className="relative max-w-3xl mx-auto px-4 pt-2.5 pb-2 flex flex-col gap-1.5">
        {menu.length > 0 && (
          <div role="listbox" className="absolute left-4 right-4 bottom-full mb-1 z-20 max-h-72 overflow-y-auto
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

        <TextArea
          ref={ref}
          value={c.draft}
          onChange={(e) => store.setDraft(tabId, e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={busy ? t("chat.placeholderBusy") : t("chat.placeholder")}
          rows={1}
          autoResize
          resize="none"
          variant="outline"
          className="max-h-60 text-[13px]"
        />

        <div className="flex items-center gap-1 flex-wrap">
          <Tooltip content={t("chat.attach")}>
            <Button variant="custom" onClick={() => void attach()} aria-label={t("chat.attach")}
              className={chip}>
              <AddIcon className="w-3.5 h-3.5" />
            </Button>
          </Tooltip>
          <Dropdown open={modelOpen} onOpenChange={setModelOpen} items={modelItems} placement="top-start"
            aria-label={t("chat.model.label")}
            trigger={<Button variant="custom" className={chip}>{modelShown}</Button>} />
          <Dropdown open={modeOpen} onOpenChange={setModeOpen} items={modeItems} placement="top-start" minWidth={320}
            aria-label={t("chat.mode.label")}
            trigger={
              <Button variant="custom"
                className={`${chip} ${c.mode === "bypassPermissions" ? "text-red-600 dark:text-red-400" : ""}`}>
                {t(`chat.mode.${c.mode}`)}
              </Button>
            } />
          <Tooltip content={t("chat.cmd.compact")}>
            <Button variant="custom" className={chip} onClick={() => runBuiltin("compact", "")}>
              /compact
            </Button>
          </Tooltip>
          <Tooltip content={t("chat.cmd.clear")}>
            <Button variant="custom" className={chip} onClick={() => runBuiltin("clear", "")}>
              {t("chat.newConversation")}
            </Button>
          </Tooltip>
          <span className="flex-1" />
          <span className="hidden sm:flex items-center gap-1 text-[10.5px] text-gray-400 dark:text-white/30">
            <Kbd>/</Kbd> {t("chat.hintCommands")}
          </span>
          {busy ? (
            <Button variant="danger" size="sm" onClick={() => void store.stop(tabId)} className="h-7 px-3 text-[12px]">
              {t("chat.stop")}
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={submit}
              disabled={!c.draft.trim() && c.images.length === 0} className="h-7 px-3 text-[12px]">
              {t("chat.send")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
