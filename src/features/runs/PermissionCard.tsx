import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Kbd } from "neogestify-ui-components";

import type { PendingApproval } from "./types";

/**
 * Lo que el agente quiere hacer, en la forma en que se puede decidir de un vistazo.
 *
 * Para un `Edit` eso es el diff: qué línea sale y cuál entra. Mostrar el JSON crudo del
 * `input` sería técnicamente lo mismo y prácticamente inservible — nadie aprueba un
 * `old_string`/`new_string` escapado.
 */
interface Preview {
  /** `Edit(store.rs)` — de qué se trata. */
  title: string;
  /** Líneas del diff, con su signo. Vacío = no hay diff que mostrar. */
  diff: { sign: "-" | "+" | " "; text: string }[];
  /** Para lo que no es un diff (un comando, una URL), el texto tal cual. */
  literal?: string;
}

const MAX_DIFF_LINES = 10;

export function buildPreview(tool: string, input: Record<string, unknown>): Preview {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);

  if (tool === "Edit" || tool === "NotebookEdit") {
    const before = str("old_string") ?? "";
    const after = str("new_string") ?? "";
    return {
      title: `${tool}(${shortPath(str("file_path"))})`,
      diff: [
        ...lines(before).map((text) => ({ sign: "-" as const, text })),
        ...lines(after).map((text) => ({ sign: "+" as const, text })),
      ].slice(0, MAX_DIFF_LINES),
    };
  }

  if (tool === "Write") {
    return {
      title: `${tool}(${shortPath(str("file_path"))})`,
      diff: lines(str("content") ?? "")
        .slice(0, MAX_DIFF_LINES)
        .map((text) => ({ sign: "+" as const, text })),
    };
  }

  // Bash y compañía: el comando ES la decisión, no hay diff.
  const literal = str("command") ?? str("url") ?? str("pattern") ?? str("file_path");
  return { title: tool, diff: [], literal };
}

function lines(text: string): string[] {
  return text.split("\n").filter((l, i, all) => l.length > 0 || i < all.length - 1);
}

function shortPath(path?: string): string {
  if (!path) return "";
  const parts = path.split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

/**
 * La tarjeta que pide una decisión.
 *
 * `y` aprueba y `n` rechaza sin sacar las manos del teclado, que es como se contesta una
 * cola: con cinco agentes, obligar a apuntar y clickear cada permiso es lo que hace que la
 * gente termine aprobando todo junto sin leer.
 *
 * "Recordar" es un interruptor y no un tercer botón porque aplica a las DOS respuestas:
 * recordar un rechazo (`git push`, nunca) vale tanto como recordar una aprobación. Y
 * muestra la regla tal cual se va a guardar, no una descripción de ella — lo que se
 * recuerda es exactamente lo que se ve.
 */
export function PermissionCard({ approval, onDecide, focused }: {
  approval: PendingApproval;
  onDecide: (allow: boolean, remember: boolean) => void;
  /** Solo la tarjeta enfocada responde al teclado: con varias, `y` sería ambiguo. */
  focused: boolean;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState(false);
  const canRemember = approval.suggestedRule !== null;
  const preview = useMemo(
    () => buildPreview(approval.toolName, approval.input),
    [approval.toolName, approval.input]
  );

  const decide = (allow: boolean) => {
    if (busy) return;
    setBusy(true);
    onDecide(allow, canRemember && remember);
  };

  useEffect(() => {
    if (!focused || busy) return;
    const onKey = (e: KeyboardEvent) => {
      // Con un campo de texto enfocado, `y` es una letra que alguien está escribiendo.
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      if (e.key === "y" || e.key === "Y") { e.preventDefault(); decide(true); }
      if (e.key === "n" || e.key === "N") { e.preventDefault(); decide(false); }
      if ((e.key === "r" || e.key === "R") && canRemember) {
        e.preventDefault();
        setRemember((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `remember` va en las dependencias: sin él, `y` usaría el valor del interruptor del
    // momento en que se montó el listener, y "recordar" se ignoraría en silencio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, busy, approval.id, remember, canRemember]);

  return (
    <div className="flex flex-col gap-2 mx-3 mb-2.5 p-2.5 rounded-lg
      bg-amber-50 dark:bg-amber-500/8
      border border-amber-300/70 dark:border-amber-500/25">

      <span className="truncate font-mono text-[10.5px] text-amber-800 dark:text-amber-300/90">
        {preview.title}
      </span>

      {preview.diff.length > 0 && (
        <div className="flex flex-col rounded overflow-hidden bg-white/60 dark:bg-black/25">
          {preview.diff.map((line, i) => (
            <span
              key={i}
              // `whitespace-pre` y no `truncate`: `truncate` trae `nowrap`, que colapsa los
              // espacios del principio, y un diff sin indentación esconde justo cambios como
              // mover una línea de nivel.
              className={`overflow-hidden text-ellipsis whitespace-pre [tab-size:2]
                px-1.5 font-mono text-[10px] leading-[1.45]
                ${line.sign === "-"
                  ? "bg-red-500/10 text-red-700 dark:text-red-300"
                  : line.sign === "+"
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "text-gray-600 dark:text-white/50"}`}
            >
              <span className="select-none opacity-50">{line.sign} </span>
              {line.text || " "}
            </span>
          ))}
        </div>
      )}

      {preview.literal && (
        <span className="line-clamp-3 px-1.5 py-1 rounded font-mono text-[10px] leading-relaxed
          bg-white/60 dark:bg-black/25 text-gray-700 dark:text-white/65">
          {preview.literal}
        </span>
      )}

      {canRemember && (
        <label className="flex items-center gap-1.5 min-w-0 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            disabled={busy}
            className="shrink-0 accent-amber-600"
          />
          <span className="shrink-0 text-[10px] text-amber-800/80 dark:text-amber-300/70">
            <Kbd>r</Kbd> {t("fleet.permission.remember")}
          </span>
          <span
            title={approval.suggestedRule ?? undefined}
            className="truncate font-mono text-[10px] text-amber-900/60 dark:text-amber-200/45"
          >
            {approval.suggestedRule}
          </span>
        </label>
      )}

      <div className="flex items-center gap-1.5">
        <button onClick={() => decide(true)} disabled={busy} className={`${BTN}
          bg-emerald-500/15 text-emerald-800 dark:text-emerald-300
          hover:bg-emerald-500/25`}>
          <Kbd>y</Kbd> {t("fleet.permission.allow")}
        </button>
        <button onClick={() => decide(false)} disabled={busy} className={`${BTN}
          text-gray-600 dark:text-white/50
          hover:bg-gray-200 dark:hover:bg-white/10`}>
          <Kbd>n</Kbd> {t("fleet.permission.deny")}
        </button>
        <div className="flex-1" />
        <BlockedFor since={approval.askedAt} />
      </div>
    </div>
  );
}

const BTN = `cc-t flex items-center gap-1.5 px-2 h-6 rounded text-[10.5px]
  disabled:opacity-40`;

/**
 * Cuánto hace que el agente está parado esperando.
 *
 * Avanza de verdad. Un número congelado diría "0:00" para siempre, que es justo lo
 * contrario de lo que este dato tiene que transmitir: que hay alguien esperando y hace
 * rato.
 */
function BlockedFor({ since }: { since: number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now() / 1000);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);

  const secs = Math.max(0, Math.floor(now - since));
  const mm = Math.floor(secs / 60);
  const ss = String(secs % 60).padStart(2, "0");

  return (
    <span className="shrink-0 tabular-nums text-[10px] text-amber-700/70 dark:text-amber-300/50">
      {t("fleet.permission.blocked", { secs: `${mm}:${ss}` })}
    </span>
  );
}
