import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { TrashIcon } from "neogestify-ui-components";

import {
  clearNetwork, EMPTY_LOG, filterRequests, formatBytes, formatClock, isFailed, requestRows,
  type RequestRow, type RequestType,
} from "../debugLog";
import { refreshProxyLog, useDebugStore } from "../debugStore";
import { previewClearNetwork } from "../ipc";
import { Empty, FilterChip, IconAction, PanelToolbar, SearchField } from "./parts";

const TYPES: (RequestType | "all")[] = ["all", "document", "script", "style", "image", "font", "fetch", "websocket", "media", "other"];

/** Lo que se muestra de una URL: la ruta si es del propio servidor, host + ruta si no. */
function nameOf(row: RequestRow, targetOrigin: string | null): { name: string; host: string | null } {
  try {
    const url = new URL(row.url);
    const path = `${url.pathname}${url.search}` || "/";
    return url.origin === targetOrigin ? { name: path, host: null } : { name: path, host: url.host };
  } catch {
    return { name: row.url, host: null };
  }
}

function statusTone(row: RequestRow): string {
  if (isFailed(row)) return "text-red-600 dark:text-red-400";
  if (row.status !== null && row.status >= 300) return "text-blue-600 dark:text-blue-400";
  return "text-gray-500 dark:text-white/45";
}

/**
 * La red de la página: lo del propio servidor lo cuenta el proxy (con el documento, el
 * status exacto y las cabeceras de cookies) y lo de otros orígenes, la página.
 */
export function NetworkView({ viewId, proxyOrigin, targetOrigin }: {
  viewId: string;
  proxyOrigin: string | null;
  targetOrigin: string | null;
}) {
  const { t } = useTranslation();
  const log = useDebugStore((s) => s.logs[viewId] ?? EMPTY_LOG);
  const apply = useDebugStore((s) => s.apply);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<RequestType | "all">("all");
  const [failedOnly, setFailedOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  // Solo mientras se mira: el proxy guarda lo suyo igual, y se trae todo junto al volver.
  useEffect(() => {
    if (!proxyOrigin) return;
    const tick = () => { refreshProxyLog(viewId, proxyOrigin).catch(() => undefined); };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [viewId, proxyOrigin]);

  const rows = useMemo(() => requestRows(log), [log]);
  const shown = useMemo(() => filterRequests(rows, { text: query, type, failedOnly }), [rows, query, type, failedOnly]);
  const failed = useMemo(() => rows.filter(isFailed).length, [rows]);
  const slowest = useMemo(() => Math.max(1, ...shown.map((r) => r.durationMs ?? 0)), [shown]);
  const total = useMemo(() => shown.reduce((sum, r) => sum + (r.size ?? 0), 0), [shown]);

  const clear = () => {
    if (proxyOrigin) previewClearNetwork(proxyOrigin).catch(() => undefined);
    apply(viewId, clearNetwork);
    setSelected(null);
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <PanelToolbar>
        {TYPES.map((kind) => (
          <FilterChip key={kind} active={type === kind} onClick={() => setType(kind)}>
            {t(`browser.debug.network.type.${kind}`)}
          </FilterChip>
        ))}
        <div className="w-px h-4 mx-0.5 shrink-0 bg-gray-200 dark:bg-white/10" />
        <FilterChip active={failedOnly} onClick={() => setFailedOnly((v) => !v)} tone="error">
          {t("browser.debug.network.failed")} {failed > 0 && <span>{failed}</span>}
        </FilterChip>
        <div className="flex-1" />
        <SearchField value={query} onChange={setQuery} placeholder={t("browser.debug.filter")} />
        <IconAction label={t("browser.debug.network.clear")} onClick={clear}>
          <TrashIcon className="w-3.5 h-3.5" />
        </IconAction>
      </PanelToolbar>

      <div className="flex-1 min-h-0 overflow-auto cc-scroll">
        {shown.length === 0 ? (
          <Empty>{rows.length === 0 ? t("browser.debug.network.empty") : t("browser.debug.noMatches")}</Empty>
        ) : (
          <table className="w-full min-w-[640px] border-collapse text-[11.5px]">
            <thead className="sticky top-0 z-[1] bg-gray-50 dark:bg-[#10141b]">
              <tr className="text-left text-[10.5px] font-semibold text-gray-500 dark:text-white/40">
                <th className="w-14 px-3 py-1 font-semibold">{t("browser.debug.network.status")}</th>
                <th className="w-14 px-1 py-1 font-semibold">{t("browser.debug.network.method")}</th>
                <th className="px-1 py-1 font-semibold">{t("browser.debug.network.name")}</th>
                <th className="w-20 px-1 py-1 font-semibold">{t("browser.debug.network.kind")}</th>
                <th className="w-16 px-1 py-1 font-semibold text-right">{t("browser.debug.network.size")}</th>
                <th className="w-36 px-3 py-1 font-semibold">{t("browser.debug.network.time")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const { name, host } = nameOf(row, targetOrigin);
                const open = selected === row.key;
                return (
                  <FragmentRow key={row.key} open={open}
                    onToggle={() => setSelected(open ? null : row.key)}
                    detail={
                      <div className="flex flex-col gap-0.5 font-mono text-[10.5px] text-gray-600 dark:text-white/55">
                        <span className="break-all text-gray-800 dark:text-gray-200">{row.url}</span>
                        <span>
                          {formatClock(row.at)} · {row.via === "proxy" ? t("browser.debug.network.viaProxy") : t("browser.debug.network.viaPage")}
                          {row.contentType ? ` · ${row.contentType}` : ""}
                        </span>
                        {row.error && <span className="text-red-600 dark:text-red-400">{row.error}</span>}
                      </div>
                    }
                  >
                    <td className={`px-3 py-[3px] font-mono tabular-nums ${statusTone(row)}`}>
                      {row.error ? "ERR" : row.status ?? "—"}
                    </td>
                    <td className="px-1 font-mono text-[10.5px] text-gray-500 dark:text-white/45">{row.method}</td>
                    <td className="px-1 max-w-0">
                      <span className={`block truncate font-mono ${isFailed(row) ? "text-red-600 dark:text-red-400" : "text-gray-800 dark:text-gray-200"}`}>
                        {host && <span className="text-gray-400 dark:text-white/35">{host}</span>}{name}
                      </span>
                    </td>
                    <td className="px-1 text-gray-500 dark:text-white/45">{t(`browser.debug.network.type.${row.type}`)}</td>
                    <td className="px-1 text-right tabular-nums text-gray-500 dark:text-white/45">{formatBytes(row.size)}</td>
                    <td className="px-3">
                      <span className="flex items-center gap-1.5">
                        <span className="w-14 shrink-0 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-white/45">
                          {row.durationMs !== null ? `${row.durationMs} ms` : "—"}
                        </span>
                        <span className="flex-1 h-1.5 rounded-full bg-gray-200/70 dark:bg-white/6 overflow-hidden">
                          <span
                            className={`block h-full rounded-full ${isFailed(row) ? "bg-red-400" : "bg-blue-400/80"}`}
                            style={{ width: `${Math.max(3, ((row.durationMs ?? 0) / slowest) * 100)}%` }}
                          />
                        </span>
                      </span>
                    </td>
                  </FragmentRow>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex items-center gap-3 h-7 shrink-0 px-3 border-t border-gray-200 dark:border-white/7
        text-[10.5px] tabular-nums text-gray-500 dark:text-white/40">
        <span>{t("browser.debug.network.summary", { shown: shown.length, total: rows.length })}</span>
        <span>{formatBytes(total)}</span>
        {failed > 0 && <span className="text-red-600 dark:text-red-400">{t("browser.debug.network.failedCount", { n: failed })}</span>}
        <div className="flex-1" />
        {!proxyOrigin && <span>{t("browser.debug.network.noProxy")}</span>}
      </div>
    </div>
  );
}

function FragmentRow({ open, onToggle, detail, children }: {
  open: boolean;
  onToggle: () => void;
  detail: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      <tr onClick={onToggle}
        className={`cursor-pointer border-b border-gray-100 dark:border-white/5
          ${open ? "bg-blue-50 dark:bg-blue-500/10" : "hover:bg-gray-100/70 dark:hover:bg-white/4"}`}>
        {children}
      </tr>
      {open && (
        <tr className="border-b border-gray-100 dark:border-white/5 bg-blue-50/50 dark:bg-blue-500/5">
          <td colSpan={6} className="px-3 py-1.5">{detail}</td>
        </tr>
      )}
    </>
  );
}
