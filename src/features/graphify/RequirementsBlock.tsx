import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimateSpin, Button, CheckCircleIcon, Input } from "neogestify-ui-components";
import { openUrl } from "@tauri-apps/plugin-opener";

import { graphifyRequirements, type GraphifyRequirement, type GraphifyRun } from "./ipc";

/**
 * Lo que hay que tener antes de instalar graphify: Python, y uv o pipx.
 *
 * Existe porque el paso 1 del instalador (`uv tool install graphifyy`) supone que `uv` ya
 * está, y en una máquina recién armada no está: el botón contestaba
 * `uv: command not found` y ahí se terminaba la sección. Los comandos son los de la tabla
 * *Prerequisites* del README, el de este sistema elegido y los otros a la vista.
 *
 * El de `uv` en Linux baja un script y lo ejecuta (`curl … | sh`). Va tal como lo documenta
 * graphify, editable y sin ejecutarse solo: traer y correr código remoto es una decisión de
 * quien usa la máquina, no algo que la app deba hacer por su cuenta.
 */
export function RequirementsBlock({ onRun, running }: {
  /** Ejecuta un comando y devuelve cómo terminó. Lo provee la sección, que sabe el cwd. */
  onRun: (command: string) => Promise<GraphifyRun>;
  running: boolean;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<GraphifyRequirement[] | null>(null);
  const [commands, setCommands] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const fresh = await graphifyRequirements().catch(() => []);
    setItems(fresh);
    setCommands((prev) => {
      const next = { ...prev };
      for (const item of fresh) {
        if (next[item.id] === undefined) next[item.id] = item.install ?? "";
      }
      return next;
    });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const run = async (id: string) => {
    setBusy(id);
    try {
      await onRun(commands[id] ?? "");
      // Instalar uno cambia lo que hay en el PATH: se vuelve a sondear todo.
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  if (!items) return null;

  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => {
        const command = commands[item.id] ?? "";
        return (
          <div key={item.id} className="flex flex-col gap-1.5 px-3 py-2 rounded-lg
            bg-gray-100/70 dark:bg-white/4">
            <div className="flex items-center gap-2">
              {item.version ? (
                <CheckCircleIcon className="w-3.5 h-3.5 shrink-0 text-emerald-500" />
              ) : (
                <span className="w-1.5 h-1.5 mx-1 rounded-full shrink-0 bg-amber-500" />
              )}
              <span className="font-mono text-[11.5px] text-gray-800 dark:text-gray-100">
                {item.command}
              </span>
              <span className="flex-1 min-w-0 truncate text-[10.5px]
                text-gray-400 dark:text-white/35">
                {item.version ?? t("settings.graphify.req.missing")}
              </span>
              <button
                onClick={() => openUrl(item.docsUrl)}
                className="cc-t shrink-0 text-[10.5px] text-blue-600 dark:text-blue-400 hover:underline"
              >
                {t("settings.graphify.req.docs")}
              </button>
            </div>

            {/* Ya instalado: el comando queda disponible igual (reinstalar, actualizar),
                pero no se le pone un botón al frente de algo que ya está. */}
            {!item.version && (
              command || item.otherInstalls.length > 0 ? (
                <>
                  <div className="flex items-center gap-2">
                    <Input
                      value={command}
                      onChange={(e) => setCommands((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      variant="minimal"
                      size="sm"
                      className="flex-1 !font-mono !text-[11px]"
                      spellCheck={false}
                      placeholder={t("settings.graphify.req.noCommand")}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={running || busy !== null || !command.trim()}
                      onClick={() => run(item.id)}
                      leftIcon={busy === item.id ? <AnimateSpin className="w-3.5 h-3.5" /> : undefined}
                    >
                      {t("settings.graphify.run")}
                    </Button>
                  </div>
                  {item.otherInstalls.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {item.otherInstalls.map((alt) => (
                        <button
                          key={alt}
                          onClick={() => setCommands((prev) => ({ ...prev, [item.id]: alt }))}
                          className="cc-t px-2 py-0.5 rounded font-mono text-[10px]
                            bg-gray-100 dark:bg-white/5 text-gray-500 dark:text-white/40
                            hover:bg-gray-200 dark:hover:bg-white/10"
                        >
                          {alt}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <p className="text-[10.5px] text-gray-400 dark:text-white/35">
                  {t("settings.graphify.req.download")}
                </p>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}
