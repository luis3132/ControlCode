import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "neogestify-ui-components";
import { AnimateSpin, CheckCircleIcon, InfoIcon } from "neogestify-ui-components";

/** Ver `ipc/install.rs`. */
interface CliInstallStatus {
  installed: boolean;
  targetPath: string;
  sourcePath: string | null;
  dirInPath: boolean;
  targetDir: string;
  method: "symlink" | "copy";
}

/**
 * Instala la CLI `ccode` en el PATH del usuario.
 *
 * El binario ya viaja con la app, pero en macOS vive dentro del `.app` (que nunca está en
 * el PATH) y en Windows el caso portable tampoco lo agrega — de ahí este paso explícito,
 * el mismo que hace VS Code con su comando `code`. Nunca pide permisos de administrador.
 */
export function CliInstallSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CliInstallStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<CliInstallStatus>("cli_install_status"));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const run = async (command: "install_cli" | "uninstall_cli") => {
    setBusy(true);
    setError("");
    try {
      setStatus(await invoke<CliInstallStatus>(command));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-linear-to-br from-white to-gray-50
      dark:from-gray-800 dark:to-gray-900
      rounded-xl border border-gray-200 dark:border-gray-700
      shadow-sm hover:shadow-md transition-shadow duration-300 p-6">

      <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-1">
        {t("settings.cli")}
      </h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
        {t("settings.cli.desc")}
      </p>

      {status && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            {status.installed ? (
              <>
                <CheckCircleIcon className="w-4 h-4 shrink-0 text-emerald-500" />
                <span className="text-sm text-gray-700 dark:text-gray-200">
                  {t("settings.cli.installed")}
                </span>
              </>
            ) : (
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {t("settings.cli.notInstalled")}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1 text-xs">
            <span className="text-gray-400 dark:text-gray-500">
              {t("settings.cli.location")}
            </span>
            <code className="font-mono text-gray-600 dark:text-gray-300 break-all">
              {status.targetPath}
            </code>
          </div>

          {/* En macOS una app lanzada desde Finder hereda un PATH mínimo, no el de tu
              shell, así que esto puede ser un falso negativo. Por eso es un aviso con la
              línea a copiar, y no un error que bloquee. */}
          {status.installed && !status.dirInPath && (
            <div className="flex items-start gap-2 p-3 rounded-lg
              bg-amber-50 dark:bg-amber-500/10
              border border-amber-200 dark:border-amber-500/20">
              <InfoIcon className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
              <div className="flex flex-col gap-1.5 min-w-0">
                <span className="text-xs text-amber-700 dark:text-amber-300">
                  {t("settings.cli.notInPath")}
                </span>
                <code className="text-[11px] font-mono break-all
                  text-amber-800 dark:text-amber-200">
                  export PATH="{status.targetDir}:$PATH"
                </code>
              </div>
            </div>
          )}

          {status.method === "copy" && status.installed && (
            <p className="text-[11px] text-gray-400 dark:text-white/40">
              {t("settings.cli.copyNote")}
            </p>
          )}

          {!status.sourcePath && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t("settings.cli.noBinary")}
            </p>
          )}

          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              disabled={busy || !status.sourcePath}
              onClick={() => run("install_cli")}
              className="!text-sm"
              leftIcon={busy ? <AnimateSpin className="w-4 h-4" /> : undefined}
            >
              {status.installed ? t("settings.cli.reinstall") : t("settings.cli.install")}
            </Button>
            {status.installed && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => run("uninstall_cli")}
                className="!text-sm"
              >
                {t("settings.cli.uninstall")}
              </Button>
            )}
          </div>

          <p className="text-[11px] text-gray-400 dark:text-white/40">
            {t("settings.cli.usage")}
          </p>
        </div>
      )}

      {error && <p className="text-xs text-red-500 dark:text-red-400 mt-3">{error}</p>}
    </section>
  );
}
