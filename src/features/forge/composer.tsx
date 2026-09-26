/**
 * Las piezas que comparten los diálogos de crear un PR, un issue y una release: el campo de
 * Markdown con vista previa, el selector de ramas y lo que se deriva de las ramas del repo.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Combobox, type ComboboxOption } from "neogestify-ui-components";

import { Markdown } from "@/shared/ui/Markdown";
import type { Branch } from "@/features/scm/types";

// ── Ramas ────────────────────────────────────────────────────────

/** Una rama tal como la ve el host: por su nombre, sin el prefijo del remoto. */
export interface HostBranch {
  name: string;
  local: boolean;
  /** Está en el remoto del repo (`origin/<name>`). */
  remote: boolean;
  current: boolean;
  updatedAt: number;
}

/**
 * Las ramas que tiene sentido ofrecer para un PR o una release: las locales y las del remoto
 * del repo, fusionadas por nombre. Las de otros remotos no: el host no las conoce.
 */
export function hostBranches(branches: Branch[], remote: string): HostBranch[] {
  const prefix = `${remote}/`;
  const byName = new Map<string, HostBranch>();
  for (const b of branches) {
    let name = b.name;
    if (b.remote) {
      if (!name.startsWith(prefix)) continue;
      name = name.slice(prefix.length);
      if (name === "HEAD") continue;
    }
    const prev = byName.get(name) ?? { name, local: false, remote: false, current: false, updatedAt: 0 };
    byName.set(name, {
      ...prev,
      local: prev.local || !b.remote,
      remote: prev.remote || b.remote,
      current: prev.current || b.current,
      updatedAt: Math.max(prev.updatedAt, b.updatedAt),
    });
  }
  // La actual primero, después las tocadas hace menos.
  return [...byName.values()].sort((a, b) => Number(b.current) - Number(a.current) || b.updatedAt - a.updatedAt);
}

/**
 * La ref con la que comparar una rama. La base, como está en el remoto: es contra lo que
 * el host va a calcular el PR. La rama del PR, como está local si existe: es la que se sube.
 */
export function compareRef(branch: HostBranch | undefined, remote: string, side: "base" | "head"): string | null {
  if (!branch) return null;
  const onRemote = `${remote}/${branch.name}`;
  if (side === "base") return branch.remote ? onRemote : branch.name;
  return branch.local ? branch.name : onRemote;
}

/** Un selector de rama con búsqueda. */
export function BranchPicker({ label, branches, value, onChange, disabled, error }: {
  label: string;
  branches: HostBranch[];
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
  error?: string;
}) {
  const { t } = useTranslation();
  const options: ComboboxOption[] = branches.map((b) => ({
    value: b.name,
    label: b.name,
    description: b.current
      ? t("forge.branch.current")
      : !b.local ? t("forge.branch.remoteOnly") : !b.remote ? t("forge.branch.localOnly") : undefined,
  }));
  // Una rama que ya no está en la lista (la escribió el host, o se borró) igual se muestra.
  if (value && !options.some((o) => o.value === value)) options.unshift({ value, label: value });
  return (
    <Combobox
      label={label}
      options={options}
      value={value}
      onChange={onChange}
      disabled={disabled}
      error={error}
      placeholder={t("forge.branch.pick")}
      emptyState={<span className="text-[11.5px]">{t("forge.branch.none")}</span>}
      maxListHeight={260}
    />
  );
}

// ── Texto ────────────────────────────────────────────────────────

/** `feat/nueva-ui_pr` → `Feat nueva ui pr`: un título de partida para un PR de un solo paso. */
export function titleFromBranch(branch: string): string {
  const words = branch.replace(/[/_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

// ── Markdown ─────────────────────────────────────────────────────

/**
 * Un área de texto con pestañas Escribir / Vista previa, como en el host: el cuerpo de un
 * PR o una release se lee renderizado, y conviene verlo así antes de publicarlo.
 */
export function MarkdownField({ label, value, onChange, disabled, rows = 8, placeholder, actions }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  rows?: number;
  placeholder?: string;
  /** Botones propios a la derecha de la cabecera (usar unas notas ya escritas, generar…). */
  actions?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState(false);
  const minHeight = `${rows * 1.55 + 1.2}rem`;

  const tab = (on: boolean, text: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className={`cc-t px-2.5 h-6 rounded-md text-[11.5px] font-medium
        ${on
          ? "bg-white dark:bg-white/12 text-gray-900 dark:text-white shadow-sm"
          : "text-gray-500 dark:text-white/45 hover:text-gray-800 dark:hover:text-white/80"}`}
    >
      {text}
    </button>
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[12px] font-medium text-gray-700 dark:text-gray-200">{label}</span>
        <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-gray-100 dark:bg-white/6">
          {tab(!preview, t("forge.write"), () => setPreview(false))}
          {tab(preview, t("forge.preview"), () => setPreview(true))}
        </div>
        <div className="flex-1" />
        {actions}
      </div>
      {preview ? (
        <div
          className="overflow-auto cc-scroll rounded-lg border border-gray-200 dark:border-white/10 px-3 py-2.5"
          style={{ minHeight, maxHeight: "22rem" }}
        >
          {value.trim()
            ? <Markdown content={value} />
            : <p className="text-[12px] text-gray-400 dark:text-white/35">{t("forge.previewEmpty")}</p>}
        </div>
      ) : (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck
          className="w-full resize-y rounded-lg border border-gray-200 dark:border-white/10 bg-transparent
            px-3 py-2 text-[12.5px] leading-relaxed font-mono text-gray-800 dark:text-gray-100
            placeholder:text-gray-400 dark:placeholder:text-white/30
            focus:outline-none focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20
            disabled:opacity-60"
          style={{ minHeight, maxHeight: "22rem" }}
        />
      )}
    </div>
  );
}

/** Un botón de texto chico para la cabecera de un campo. */
export function FieldAction({ onClick, disabled, children, title }: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="cc-t max-w-[60%] truncate text-[11.5px] text-blue-600 dark:text-blue-400 hover:underline
        disabled:opacity-50 disabled:no-underline"
    >
      {children}
    </button>
  );
}
