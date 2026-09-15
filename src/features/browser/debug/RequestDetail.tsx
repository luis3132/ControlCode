import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRightIcon, CloseIcon } from "neogestify-ui-components";

import { formatBytes, formatClock } from "../debugLog";
import {
  bodyView, curlCommand, failureKey, formFields, queryParams, requestCookies, responseCookies, statusClass,
  type ParsedCookie, type RequestDetail,
} from "../networkDetail";
import type { NetBody, NetHeader } from "../protocol";
import { Empty, TextAction } from "./parts";

type DetailTab = "headers" | "payload" | "response" | "cookies" | "timing";

const STATUS_TONE: Record<string, string> = {
  info: "text-gray-500 dark:text-white/50",
  success: "text-emerald-600 dark:text-emerald-400",
  redirect: "text-blue-600 dark:text-blue-400",
  client: "text-amber-600 dark:text-amber-400",
  server: "text-red-600 dark:text-red-400",
};

/** Una sección plegable, como las de las devtools. */
function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="border-b border-gray-200 dark:border-white/7">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="flex items-center gap-1.5 w-full h-7 px-2.5 text-left text-[11px] font-semibold
          text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/4">
        <ChevronRightIcon className={`w-3 h-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        {title}
        {count !== undefined && <span className="font-normal tabular-nums text-gray-400 dark:text-white/35">{count}</span>}
      </button>
      {open && <div className="pb-2 px-2.5">{children}</div>}
    </section>
  );
}

function Rows({ rows }: { rows: { name: string; value: ReactNode; note?: string | null; tone?: string }[] }) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,max-content)_1fr] gap-x-3 gap-y-0.5 pl-4 font-mono text-[11px] leading-[1.45]">
      {rows.map((row, i) => (
        <div key={`${row.name}-${i}`} className="contents">
          <dt className="text-gray-500 dark:text-white/45 break-all">{row.name}</dt>
          <dd className={`min-w-0 break-all ${row.tone ?? "text-gray-800 dark:text-gray-200"}`}>
            {row.value}
            {row.note && (
              <span className="ml-2 px-1 rounded bg-gray-200/80 dark:bg-white/8 font-sans text-[9.5px] text-gray-500 dark:text-white/45 whitespace-nowrap">
                {row.note}
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function HeaderRows({ headers }: { headers: NetHeader[] }) {
  const { t } = useTranslation();
  if (headers.length === 0) {
    return <p className="pl-4 text-[11px] text-gray-400 dark:text-white/30">{t("browser.debug.network.noHeaders")}</p>;
  }
  const noteOf = (h: NetHeader) =>
    h.note === "rewritten" ? t("browser.debug.network.noteRewritten") : h.note === "removed" ? t("browser.debug.network.noteRemoved") : null;
  return <Rows rows={headers.map((h) => ({ name: h.name, value: h.value, note: noteOf(h) }))} />;
}

/** El cuerpo como se pueda mostrar: JSON indentado, texto, imagen, o por qué no. */
function BodyBlock({ body, pending, websocket }: { body: NetBody | null; pending?: boolean; websocket?: boolean }) {
  const { t } = useTranslation();
  const view = bodyView(body);
  const message = (text: string) => <p className="text-[11px] text-gray-500 dark:text-white/45">{text}</p>;
  if (view.kind === "none") {
    if (websocket) return message(t("browser.debug.network.websocketBody"));
    return message(pending ? t("browser.debug.network.pendingBody") : t("browser.debug.network.noBody"));
  }
  const truncated = body?.truncated && (view.kind === "text" || view.kind === "json") ? (
    <p className="mb-1 text-[10.5px] text-amber-700 dark:text-amber-400">
      {body.size !== null
        ? t("browser.debug.network.bodyTruncated", { size: formatBytes(new TextEncoder().encode(view.text).length), total: formatBytes(body.size) })
        : t("browser.debug.network.bodyTruncatedUnknown")}
    </p>
  ) : null;
  switch (view.kind) {
    case "json":
    case "text":
      return (
        <div>
          {truncated}
          {body?.summary && <p className="mb-1 text-[10.5px] text-gray-500 dark:text-white/45">{body.summary}</p>}
          <pre className="max-h-[60vh] overflow-auto cc-scroll p-2 rounded-md bg-white dark:bg-black/30 border border-gray-200 dark:border-white/8
            font-mono text-[11px] leading-[1.45] whitespace-pre-wrap break-all text-gray-800 dark:text-gray-200">
            {view.text || " "}
          </pre>
        </div>
      );
    case "image":
      return <img src={view.dataUrl} alt="" className="max-w-full max-h-72 rounded border border-gray-200 dark:border-white/10 bg-[repeating-conic-gradient(#e5e7eb_0_25%,transparent_0_50%)] bg-[length:16px_16px]" />;
    case "binary":
      return message(t("browser.debug.network.bodyBinary", { size: formatBytes(body?.size ?? null) }));
    case "compressed":
      return message(t("browser.debug.network.bodyCompressed", { encoding: view.encoding }));
    case "evicted":
      return message(t("browser.debug.network.bodyEvicted"));
    case "summary":
      return message(view.text);
  }
}

function CookieRows({ cookies }: { cookies: ParsedCookie[] }) {
  return (
    <Rows rows={cookies.map((c) => ({
      name: c.name,
      value: (
        <>
          {c.value}
          {c.attributes.length > 0 && (
            <span className="block text-[10.5px] text-gray-500 dark:text-white/40">{c.attributes.join(" · ")}</span>
          )}
        </>
      ),
    }))} />
  );
}

function useCopy(): [string | null, (id: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  const copy = (id: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => setCopied(id)).catch(console.error);
  };
  return [copied, copy];
}

/**
 * El detalle de un pedido, al costado de la lista: encabezados, lo que mandó, lo que
 * volvió, cookies y tiempos. Si falló, arriba de todo dice qué significa.
 */
export function RequestDetailPane({ detail, loading, onClose }: {
  detail: RequestDetail | null;
  loading: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<DetailTab>("headers");
  const [copied, copy] = useCopy();

  if (!detail) {
    return (
      <div className="flex flex-col flex-1 min-w-0">
        <div className="flex items-center justify-end h-8 px-1.5 border-b border-gray-200 dark:border-white/7">
          <CloseButton onClose={onClose} />
        </div>
        <Empty>{loading ? t("browser.debug.network.loading") : t("browser.debug.network.gone")}</Empty>
      </div>
    );
  }

  const params = queryParams(detail.url);
  const form = formFields(detail.requestBody);
  const sentCookies = requestCookies(detail.requestHeaders);
  const receivedCookies = responseCookies(detail.responseHeaders);
  const tabs: DetailTab[] = [
    "headers",
    ...(params.length > 0 || detail.requestBody ? ["payload" as const] : []),
    "response",
    ...(sentCookies.length + receivedCookies.length > 0 ? ["cookies" as const] : []),
    "timing",
  ];
  const current = tabs.includes(tab) ? tab : "headers";
  const tone = statusClass(detail.status);
  const failure = failureKey(detail);
  const responseText = (() => {
    const view = bodyView(detail.responseBody);
    return view.kind === "json" || view.kind === "text" ? view.text : null;
  })();

  const statusValue = detail.pending
    ? t("browser.debug.network.pending")
    : detail.error
      ? "ERR"
      : `${detail.status ?? "—"}${detail.statusText ? ` ${detail.statusText}` : ""}`;

  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0">
      <div role="tablist" className="flex items-center gap-0.5 h-8 shrink-0 px-1.5 border-b border-gray-200 dark:border-white/7 overflow-x-auto">
        <CloseButton onClose={onClose} />
        {tabs.map((id) => (
          <button key={id} role="tab" aria-selected={current === id} onClick={() => setTab(id)}
            className={`cc-t relative shrink-0 h-8 px-2 text-[11px] font-medium
              ${current === id
                ? "text-gray-900 dark:text-white after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:rounded-full after:bg-blue-500"
                : "text-gray-500 dark:text-white/45 hover:text-gray-900 dark:hover:text-white"}`}>
            {t(`browser.debug.network.tab.${id}`)}
          </button>
        ))}
        <div className="flex-1" />
        <TextAction onClick={() => copy("curl", curlCommand(detail))}>
          {copied === "curl" ? t("browser.debug.network.copied") : t("browser.debug.network.copyCurl")}
        </TextAction>
      </div>

      <div className="flex-1 min-h-0 overflow-auto cc-scroll">
        {failure && current === "headers" && (
          <div className="flex flex-col gap-0.5 m-2 px-2.5 py-2 rounded-md border
            border-red-200 dark:border-red-500/25 bg-red-50 dark:bg-red-500/8">
            <p className="text-[11.5px] font-semibold text-red-700 dark:text-red-300">
              {detail.error ? t("browser.debug.network.errorTitle") : `${detail.status} ${detail.statusText ?? ""}`}
            </p>
            <p className="text-[11px] leading-relaxed text-red-700/90 dark:text-red-300/85">{t(failure)}</p>
            {detail.error && (
              <p className="font-mono text-[10.5px] break-all text-red-700/75 dark:text-red-300/70">{detail.error}</p>
            )}
          </div>
        )}

        {current === "headers" && (
          <>
            <Section title={t("browser.debug.network.general")}>
              <Rows rows={[
                { name: t("browser.debug.network.url"), value: detail.url },
                { name: t("browser.debug.network.method"), value: detail.method },
                { name: t("browser.debug.network.statusCode"), value: statusValue, tone: detail.error ? STATUS_TONE.server : tone ? STATUS_TONE[tone] : undefined },
                ...(detail.remoteAddress ? [{ name: t("browser.debug.network.remoteAddress"), value: detail.remoteAddress }] : []),
                ...(detail.httpVersion ? [{ name: t("browser.debug.network.protocol"), value: detail.httpVersion }] : []),
                ...(detail.contentType ? [{ name: t("browser.debug.network.contentType"), value: detail.contentType }] : []),
                ...(detail.redirected && detail.finalUrl ? [{ name: t("browser.debug.network.redirectedTo"), value: detail.finalUrl }] : []),
                ...(detail.responseType ? [{ name: "fetch", value: detail.responseType }] : []),
                { name: t("browser.debug.network.seenBy"), value: detail.via === "proxy" ? t("browser.debug.network.viaProxy") : t("browser.debug.network.viaPage") },
              ]} />
            </Section>
            <Section title={t("browser.debug.network.responseHeaders")} count={detail.responseHeaders.length}>
              {detail.headersLimited && detail.responseHeaders.length > 0 && (
                <p className="mb-1 pl-4 text-[10.5px] text-gray-500 dark:text-white/40">{t("browser.debug.network.headersLimited")}</p>
              )}
              <HeaderRows headers={detail.responseHeaders} />
            </Section>
            <Section title={t("browser.debug.network.requestHeaders")} count={detail.requestHeaders.length}>
              <HeaderRows headers={detail.requestHeaders} />
            </Section>
          </>
        )}

        {current === "payload" && (
          <>
            {params.length > 0 && (
              <Section title={t("browser.debug.network.queryParams")} count={params.length}>
                <Rows rows={params.map(([name, value]) => ({ name, value }))} />
              </Section>
            )}
            {detail.requestBody && (
              <Section title={form ? t("browser.debug.network.formData") : t("browser.debug.network.requestBody")}>
                {form
                  ? <Rows rows={form.map(([name, value]) => ({ name, value }))} />
                  : <BodyBlock body={detail.requestBody} />}
              </Section>
            )}
          </>
        )}

        {current === "response" && (
          <div className="p-2.5 flex flex-col gap-1.5">
            {responseText !== null && (
              <div className="flex justify-end">
                <TextAction onClick={() => copy("response", responseText)}>
                  {copied === "response" ? t("browser.debug.network.copied") : t("browser.debug.network.copyResponse")}
                </TextAction>
              </div>
            )}
            <BodyBlock body={detail.responseBody} pending={detail.pending} websocket={detail.type === "websocket"} />
          </div>
        )}

        {current === "cookies" && (
          <>
            {receivedCookies.length > 0 && (
              <Section title={t("browser.debug.network.cookiesReceived")} count={receivedCookies.length}>
                <CookieRows cookies={receivedCookies} />
              </Section>
            )}
            {sentCookies.length > 0 && (
              <Section title={t("browser.debug.network.cookiesSent")} count={sentCookies.length}>
                <CookieRows cookies={sentCookies} />
              </Section>
            )}
          </>
        )}

        {current === "timing" && <Timing detail={detail} />}
      </div>
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <button onClick={onClose} aria-label={t("browser.debug.network.detailClose")}
      className="cc-t flex items-center justify-center w-6 h-6 shrink-0 rounded-md
        text-gray-400 dark:text-white/35 hover:text-gray-800 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10">
      <CloseIcon className="w-3.5 h-3.5" />
    </button>
  );
}

function Timing({ detail }: { detail: RequestDetail }) {
  const { t } = useTranslation();
  const total = detail.durationMs;
  const waiting = detail.ttfbMs;
  const download = total !== null && waiting !== null ? Math.max(0, total - waiting) : null;
  const scale = Math.max(1, total ?? 0);
  const bar = (label: string, ms: number | null, offset: number, color: string) => (
    <div className="grid grid-cols-[minmax(10rem,max-content)_1fr_4.5rem] items-center gap-3 text-[11px]">
      <span className="text-gray-600 dark:text-white/55">{label}</span>
      <span className="relative h-2 rounded-full bg-gray-200/70 dark:bg-white/6 overflow-hidden">
        {ms !== null && (
          <span className={`absolute inset-y-0 rounded-full ${color}`}
            style={{ left: `${(offset / scale) * 100}%`, width: `${Math.max(1.5, (ms / scale) * 100)}%` }} />
        )}
      </span>
      <span className="text-right tabular-nums text-gray-700 dark:text-gray-200">{ms !== null ? `${ms} ms` : "—"}</span>
    </div>
  );
  return (
    <div className="flex flex-col gap-2 p-3">
      <p className="text-[11px] text-gray-500 dark:text-white/45">
        {t("browser.debug.network.startedAt")} {formatClock(detail.at)}
        {detail.pending && ` · ${t("browser.debug.network.pending")}`}
      </p>
      {total === null && waiting === null ? (
        <p className="text-[11px] text-gray-500 dark:text-white/45">{t("browser.debug.network.timingUnknown")}</p>
      ) : (
        <>
          {bar(t("browser.debug.network.timingWaiting"), waiting, 0, "bg-emerald-500/80")}
          {bar(t("browser.debug.network.timingDownload"), download, waiting ?? 0, "bg-blue-500/80")}
          <div className="h-px bg-gray-200 dark:bg-white/7" />
          {bar(t("browser.debug.network.timingTotal"), total, 0, "bg-gray-500/70")}
        </>
      )}
    </div>
  );
}
