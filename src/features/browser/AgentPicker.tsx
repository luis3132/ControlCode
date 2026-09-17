import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Tab } from "@/features/tabs/types";

import { agentPaint } from "./agentPaint";
import { highlightAgent } from "./agentHighlight";

/**
 * A qué agente se le manda lo marcado.
 *
 * No es un `<select>`: con tres agentes iguales en la carpeta, «Claude Code · Claude Code ·
 * Claude Code» no se puede elegir. Acá cada uno va con su número de tab y con SU color —el
 * mismo que le prende la barra de arriba mientras está elegido o mientras se pasa el mouse
 * por su fila—, así que se elige mirando y no adivinando.
 */
export function AgentPicker({ agents, value, onChange, compact }: {
  /** Los agentes de esta carpeta, en el orden de la barra de tabs. */
  agents: Tab[];
  value: string | null;
  onChange: (id: string) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const chosen = agents.find((a) => a.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", close, { capture: true });
    window.addEventListener("keydown", esc, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", close, { capture: true });
      window.removeEventListener("keydown", esc, { capture: true });
    };
  }, [open]);

  // Al cerrar se vuelve a señalar el elegido: mientras se recorre la lista manda el de la
  // fila, pero lo que queda prendido al final es a quién se le va a mandar.
  useEffect(() => {
    if (!open && value) highlightAgent(value);
  }, [open, value]);

  const rect = box.current?.getBoundingClientRect();

  return (
    <div ref={box} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t("browser.sendTo")}
        className={`cc-t flex items-center gap-2 w-full h-8 px-2.5 rounded-lg border text-[12px]
          border-gray-300 dark:border-white/15 bg-white dark:bg-white/4
          text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-white/8
          ${open ? "border-blue-500 dark:border-blue-400" : ""}`}
      >
        {chosen
          ? <AgentRow tab={chosen} index={agents.indexOf(chosen)} />
          : <span className="text-gray-400 dark:text-white/35">{t("browser.sendTo")}</span>}
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none" className="shrink-0 ml-auto opacity-60">
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && rect && (
        // `fixed`: el panel del mensaje scrollea y es bajito; una lista `absolute` quedaría
        // recortada adentro.
        <div
          role="listbox"
          className="fixed z-50 py-1 rounded-xl shadow-lg overflow-auto
            bg-white dark:bg-[#161b22] border border-gray-200 dark:border-white/10"
          style={{
            left: rect.left,
            width: Math.max(rect.width, compact ? 200 : 240),
            // Arriba del botón si abajo no entra: el composer vive pegado al borde inferior.
            top: rect.bottom + 6 + 220 < window.innerHeight ? rect.bottom + 6 : undefined,
            bottom: rect.bottom + 6 + 220 < window.innerHeight ? undefined : window.innerHeight - rect.top + 6,
            maxHeight: 220,
          }}
        >
          {agents.map((tab, i) => (
            <button
              key={tab.id}
              role="option"
              aria-selected={tab.id === value}
              onPointerEnter={() => highlightAgent(tab.id)}
              onClick={() => {
                onChange(tab.id);
                setOpen(false);
              }}
              className={`cc-t flex items-center gap-2 w-full px-2.5 py-1.5 text-left text-[12px]
                ${tab.id === value
                  ? "bg-blue-500/10 text-gray-900 dark:text-white"
                  : "text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/8"}`}
            >
              <AgentRow tab={tab} index={i} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** El color del agente, su número de tab y su nombre. */
function AgentRow({ tab, index }: { tab: Tab; index: number }) {
  return (
    <>
      <span className={`shrink-0 w-2.5 h-2.5 rounded-full ${agentPaint(tab.id).strip}`} />
      <span className="shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-white/35">{index + 1}</span>
      <span className="min-w-0 truncate">{tab.title}</span>
    </>
  );
}
