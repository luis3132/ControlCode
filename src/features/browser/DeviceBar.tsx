import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CloseIcon, Select, Tooltip } from "neogestify-ui-components";

import { RotateIcon } from "@/app/icons";

import { breakpointOf, clampViewport, presetOf, rotate, VIEWPORT_PRESETS, type Viewport } from "./viewport";

/** Los cortes de Tailwind, con el ancho al que salta cada uno. `xs` no tiene mínimo: se
 *  prueba en el teléfono chico, que es el caso real por debajo de `sm`. */
const BREAKPOINT_WIDTHS: [string, number][] = [["xs", 360], ["sm", 640], ["md", 768], ["lg", 1024], ["xl", 1280], ["2xl", 1536]];

function SideInput({ value, label, onCommit }: { value: number; label: string; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number.parseInt(text, 10);
    if (Number.isFinite(n)) onCommit(n);
    else setText(String(value));
  };
  return (
    <input
      value={text}
      aria-label={label}
      inputMode="numeric"
      onChange={(e) => setText(e.target.value.replace(/[^\d]/g, ""))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          onCommit(value + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1));
        }
      }}
      className="w-14 h-6 px-1.5 rounded-md text-center font-mono text-[11.5px] tabular-nums outline-none
        bg-white dark:bg-white/6 border border-gray-300 dark:border-white/12
        focus:border-blue-500 dark:focus:border-blue-400 text-gray-900 dark:text-gray-100"
    />
  );
}

/** La barra del modo responsive: tamaño exacto, presets, orientación y breakpoints. */
export function DeviceBar({ viewport, touch, onChange, onTouch, onClose }: {
  viewport: Viewport;
  /** Está emulando una pantalla táctil. */
  touch: boolean;
  onChange: (viewport: Viewport) => void;
  onTouch: (on: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const match = presetOf(viewport);
  const current = breakpointOf(viewport.width);
  const set = (v: Viewport) => onChange(clampViewport(v));

  return (
    <div className="flex items-center gap-2 h-10 shrink-0 px-2.5 overflow-x-auto
      border-b border-gray-200 dark:border-white/7 bg-white/60 dark:bg-white/2">
      <div className="w-52 shrink-0">
        <Select
          size="sm"
          variant="outline"
          value={match?.preset.id ?? "custom"}
          onChange={(e) => {
            const preset = VIEWPORT_PRESETS.find((p) => p.id === e.target.value);
            if (preset) set(match?.rotated ? rotate(preset) : preset);
          }}
          options={[
            { value: "custom", label: t("browser.viewport.custom") },
            ...VIEWPORT_PRESETS.map((p) => ({
              value: p.id,
              label: `${t(`browser.viewport.preset.${p.id}`)} · ${p.width}×${p.height}`,
            })),
          ]}
        />
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <SideInput value={viewport.width} label={t("browser.viewport.width")} onCommit={(width) => set({ ...viewport, width })} />
        <span className="text-[11px] text-gray-400 dark:text-white/30">×</span>
        <SideInput value={viewport.height} label={t("browser.viewport.height")} onCommit={(height) => set({ ...viewport, height })} />
      </div>

      <Tooltip content={t("browser.viewport.rotate")} placement="bottom">
        <button onClick={() => set(rotate(viewport))} aria-label={t("browser.viewport.rotate")}
          className="cc-t flex items-center justify-center w-7 h-7 rounded-md shrink-0
            text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/10">
          <RotateIcon className="w-4 h-4" />
        </button>
      </Tooltip>

      {/* El táctil aparte del tamaño: lo más útil es prenderlo y apagarlo SIN mover el
          ancho, que es como se ve qué se rompe por el dedo y no por el espacio. */}
      <Tooltip content={t(touch ? "browser.viewport.touchOff" : "browser.viewport.touchOn")} placement="bottom">
        <button onClick={() => onTouch(!touch)} aria-pressed={touch}
          className={`cc-t h-6 px-2 rounded-md shrink-0 text-[10.5px] border
            ${touch
              ? "bg-blue-600 border-blue-600 text-white"
              : "border-gray-200 dark:border-white/10 text-gray-500 dark:text-white/45 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/8"}`}>
          {t("browser.viewport.touch")}
        </button>
      </Tooltip>

      <div className="w-px h-5 shrink-0 bg-gray-200 dark:bg-white/10" />

      {/* Los breakpoints como tira: se ve en cuál cae el ancho actual y con un click se
          salta al borde de otro, que es donde un layout suele romperse. */}
      <div role="group" aria-label={t("browser.viewport.breakpoints")} className="flex items-center shrink-0 rounded-md
        border border-gray-200 dark:border-white/10 overflow-hidden">
        {BREAKPOINT_WIDTHS.map(([name, width]) => (
          <Tooltip key={name} content={t("browser.viewport.jumpTo", { name, width })} placement="bottom">
            <button
              onClick={() => set({ ...viewport, width })}
              aria-pressed={current === name}
              className={`cc-t h-6 px-2 font-mono text-[10.5px] border-r last:border-r-0 border-gray-200 dark:border-white/10
                ${current === name
                  ? "bg-blue-600 text-white"
                  : "text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/8 hover:text-gray-900 dark:hover:text-white"}`}
            >
              {name}
            </button>
          </Tooltip>
        ))}
      </div>

      <div className="flex-1" />

      <Tooltip content={t("browser.viewport.exit")} placement="bottom">
        <button onClick={onClose} aria-label={t("browser.viewport.exit")}
          className="cc-t flex items-center justify-center w-7 h-7 rounded-md shrink-0
            text-gray-500 dark:text-white/45 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10">
          <CloseIcon className="w-3.5 h-3.5" />
        </button>
      </Tooltip>
    </div>
  );
}
