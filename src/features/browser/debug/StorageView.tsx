import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { TrashIcon } from "neogestify-ui-components";

import { RefreshIcon } from "@/app/icons";

import { formatBytes, mergeCookies, type CookieRow } from "../debugLog";
import { previewCookies } from "../ipc";
import type { PageChannel } from "../pageChannel";
import type { StorageArea } from "../protocol";
import { Empty, IconAction, PanelToolbar, TextAction } from "./parts";

interface StorageItem {
  key: string;
  value: string;
  size: number;
}

interface StorageReport {
  local: StorageItem[] | { error: string };
  session: StorageItem[] | { error: string };
  indexedDB: { name: string; version: number | null }[] | null;
  cacheStorage: string[] | null;
  serviceWorkers: string[] | null;
}

function Section({ title, count, actions, children }: {
  title: string;
  count?: number;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-gray-200 dark:border-white/7">
      <header className="flex items-center gap-2 h-8 px-3 sticky top-0 z-[1] bg-gray-50 dark:bg-[#10141b]">
        <h3 className="text-[11px] font-semibold text-gray-700 dark:text-gray-300">{title}</h3>
        {count !== undefined && <span className="text-[10.5px] tabular-nums text-gray-400 dark:text-white/30">{count}</span>}
        <div className="flex-1" />
        {actions}
      </header>
      {children}
    </section>
  );
}

function Flag({ children, tone }: { children: React.ReactNode; tone?: "warn" | "ok" }) {
  const color = tone === "warn"
    ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
    : tone === "ok"
      ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400"
      : "bg-gray-200/80 dark:bg-white/8 text-gray-600 dark:text-white/50";
  return <span className={`shrink-0 px-1.5 h-4 rounded text-[9.5px] font-semibold leading-4 ${color}`}>{children}</span>;
}

/**
 * Lo que la página guarda: cookies (con lo que ve el servidor, HttpOnly incluidas),
 * localStorage, sessionStorage y lo que haya en IndexedDB, Cache Storage y service
 * workers. Se puede borrar y agregar, que es lo que hace falta para probar "¿qué pasa si
 * no hay sesión?" sin abrir otro navegador.
 */
export function StorageView({ channel, proxyOrigin, docId }: {
  channel: PageChannel;
  proxyOrigin: string | null;
  /** Cambia al cargar otra página: es la señal para volver a leer. */
  docId: string | null;
}) {
  const { t } = useTranslation();
  const [report, setReport] = useState<StorageReport | null>(null);
  const [cookies, setCookies] = useState<CookieRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [storage, page] = await Promise.all([
        channel.run({ op: "storage", action: "list" }) as Promise<StorageReport>,
        channel.run({ op: "cookies", action: "list" }) as Promise<{ cookies: { name: string; value: string }[] }>,
      ]);
      const server = proxyOrigin ? await previewCookies(proxyOrigin).catch(() => null) : null;
      setReport(storage);
      setCookies(mergeCookies(page.cookies, server));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [channel, proxyOrigin]);

  useEffect(() => {
    void refresh();
  }, [refresh, docId]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    await refresh();
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <PanelToolbar>
        <span className="text-[11px] text-gray-500 dark:text-white/40">{t("browser.debug.storage.hint")}</span>
        <div className="flex-1" />
        <IconAction label={t("browser.debug.refresh")} onClick={() => void refresh()}>
          <RefreshIcon className="w-3.5 h-3.5" />
        </IconAction>
      </PanelToolbar>

      <div className="flex-1 min-h-0 overflow-y-auto cc-scroll">
        {error && <div className="px-3 py-2 text-[11px] text-red-600 dark:text-red-400">{error}</div>}
        {!report && !error && <Empty>{t("browser.debug.loading")}</Empty>}
        {report && (
          <>
            <Section title={t("browser.debug.storage.cookies")} count={cookies.length}>
              {cookies.length === 0 ? (
                <p className="px-3 pb-2 text-[11px] text-gray-400 dark:text-white/30">{t("browser.debug.storage.none")}</p>
              ) : cookies.map((c) => (
                <div key={`${c.name}:${c.path ?? ""}`} className="group flex items-center gap-2 px-3 py-1 border-t border-gray-100 dark:border-white/5">
                  <span className="shrink-0 max-w-[30%] truncate font-mono text-[11.5px] font-semibold text-gray-800 dark:text-gray-100" title={c.name}>{c.name}</span>
                  <span className="flex-1 min-w-0 truncate font-mono text-[11px] text-gray-500 dark:text-white/45" title={c.value}>{c.value}</span>
                  {c.httpOnly && <Flag>HttpOnly</Flag>}
                  {c.secure && <Flag>Secure</Flag>}
                  {c.sameSite && <Flag>SameSite={c.sameSite}</Flag>}
                  {c.path && <Flag>{c.path}</Flag>}
                  <Flag>{c.expiresAt ? new Date(c.expiresAt * 1000).toLocaleString() : t("browser.debug.storage.session")}</Flag>
                  {c.sent
                    ? <Flag tone="ok">{t("browser.debug.storage.sent")}</Flag>
                    : <Flag tone="warn">{t("browser.debug.storage.notSent")}</Flag>}
                  <button onClick={() => void act(() => channel.run({ op: "cookies", action: "delete", name: c.name, path: c.path ?? undefined }))}
                    aria-label={t("btn.delete")}
                    className="cc-t opacity-0 group-hover:opacity-100 focus:opacity-100 flex items-center justify-center w-5 h-5 rounded
                      text-gray-400 hover:text-red-500 hover:bg-gray-200 dark:hover:bg-white/10">
                    <TrashIcon className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </Section>

            {(["local", "session"] as StorageArea[]).map((area) => (
              <StorageSection key={area} area={area} items={report[area]}
                onRemove={(key) => void act(() => channel.run({ op: "storage", action: "remove", area, key }))}
                onClear={() => void act(() => channel.run({ op: "storage", action: "clear", area }))}
                onAdd={(key, value) => void act(() => channel.run({ op: "storage", action: "set", area, key, value }))} />
            ))}

            <Section title="IndexedDB" count={report.indexedDB?.length}>
              <NameList items={report.indexedDB?.map((d) => (d.version ? `${d.name} · v${d.version}` : d.name)) ?? null} />
            </Section>
            <Section title="Cache Storage" count={report.cacheStorage?.length}>
              <NameList items={report.cacheStorage} />
            </Section>
            <Section title="Service workers" count={report.serviceWorkers?.length}>
              <NameList items={report.serviceWorkers} />
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function NameList({ items }: { items: string[] | null }) {
  const { t } = useTranslation();
  if (items === null) return <p className="px-3 pb-2 text-[11px] text-gray-400 dark:text-white/30">{t("browser.debug.unavailable")}</p>;
  if (items.length === 0) return <p className="px-3 pb-2 text-[11px] text-gray-400 dark:text-white/30">{t("browser.debug.storage.none")}</p>;
  return (
    <ul className="px-3 pb-2">
      {items.map((name) => <li key={name} className="truncate font-mono text-[11px] text-gray-700 dark:text-gray-300">{name}</li>)}
    </ul>
  );
}

function StorageSection({ area, items, onRemove, onClear, onAdd }: {
  area: StorageArea;
  items: StorageItem[] | { error: string };
  onRemove: (key: string) => void;
  onClear: () => void;
  onAdd: (key: string, value: string) => void;
}) {
  const { t } = useTranslation();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const list = Array.isArray(items) ? items : null;
  const total = list?.reduce((sum, i) => sum + i.size * 2, 0) ?? 0;

  return (
    <Section
      title={area === "local" ? "localStorage" : "sessionStorage"}
      count={list?.length}
      actions={list && list.length > 0 && (
        <>
          <span className="text-[10.5px] tabular-nums text-gray-400 dark:text-white/30">{formatBytes(total)}</span>
          <TextAction danger onClick={onClear}>{t("browser.debug.storage.clear")}</TextAction>
        </>
      )}
    >
      {!list ? (
        <p className="px-3 pb-2 text-[11px] text-red-600 dark:text-red-400">{(items as { error: string }).error}</p>
      ) : list.map((item) => (
        <div key={item.key} className="group flex items-start gap-2 px-3 py-1 border-t border-gray-100 dark:border-white/5">
          <span className="shrink-0 w-[30%] truncate font-mono text-[11.5px] font-semibold text-gray-800 dark:text-gray-100" title={item.key}>{item.key}</span>
          <span className="flex-1 min-w-0 line-clamp-2 break-all font-mono text-[11px] text-gray-500 dark:text-white/45" title={item.value}>{item.value}</span>
          <button onClick={() => onRemove(item.key)} aria-label={t("btn.delete")}
            className="cc-t opacity-0 group-hover:opacity-100 focus:opacity-100 flex items-center justify-center w-5 h-5 rounded
              text-gray-400 hover:text-red-500 hover:bg-gray-200 dark:hover:bg-white/10">
            <TrashIcon className="w-3 h-3" />
          </button>
        </div>
      ))}
      {list && (
        <form
          className="flex items-center gap-1.5 px-3 py-1.5 border-t border-gray-100 dark:border-white/5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!key.trim()) return;
            onAdd(key.trim(), value);
            setKey("");
            setValue("");
          }}
        >
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder={t("browser.debug.storage.key")} spellCheck={false}
            className="w-[30%] h-6 px-2 rounded-md outline-none font-mono text-[11px] bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 focus:border-blue-500 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-white/25" />
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={t("browser.debug.storage.value")} spellCheck={false}
            className="flex-1 min-w-0 h-6 px-2 rounded-md outline-none font-mono text-[11px] bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 focus:border-blue-500 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-white/25" />
          <button type="submit" disabled={!key.trim()}
            className="cc-t shrink-0 h-6 px-2 rounded-md text-[11px] font-medium text-gray-600 dark:text-white/55
              hover:bg-gray-200 dark:hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent">
            {t("browser.debug.storage.add")}
          </button>
        </form>
      )}
    </Section>
  );
}
