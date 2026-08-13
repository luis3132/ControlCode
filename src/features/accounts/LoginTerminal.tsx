import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loading } from "neogestify-ui-components";
import { Terminal } from "@/features/terminal/Terminal";
import { useAccountsStore, type AgentAccount } from "@/features/accounts/store";

interface LoginTerminalProps {
  account: AgentAccount;
}

/**
 * Terminal efímera, dedicada a loguearse en una cuenta.
 *
 * Es una `Terminal` normal con dos diferencias que importan:
 *
 * - Corre con la variable de perfil de la TUI apuntada al directorio de la cuenta, así que
 *   el login que hagas acá adentro queda en ESA cuenta y no toca la del sistema.
 * - No es una tab: no se persiste, no aparece en el historial de sesiones y su proceso
 *   muere al cerrar el diálogo (el cleanup de `Terminal` mata el PTY al desmontar).
 *
 * El cwd es el home y no un proyecto: loguearse no tiene nada que ver con un repo, y
 * arrancar una TUI dentro de un proyecto puede disparar su indexado o sus permisos de
 * carpeta — ruido innecesario para un flujo que solo tiene que llegar al navegador.
 */
export function LoginTerminal({ account }: LoginTerminalProps) {
  const { t } = useTranslation();
  const { envFor, load } = useAccountsStore();
  const [env, setEnv] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    envFor(account.id).then(setEnv).catch((e) => setError(String(e)));
  }, [account.id, envFor]);

  if (error) {
    return <p className="text-xs text-red-500 dark:text-red-400">{error}</p>;
  }

  // Sin las variables todavía no se puede lanzar nada: montar la terminal antes correría el
  // login contra la cuenta del sistema, que es exactamente lo que hay que evitar.
  if (!env) {
    return (
      <div className="h-96 flex items-center justify-center rounded-lg
        border border-gray-200 dark:border-gray-700">
        <Loading variant="dots" size="small" color="gray" label={t("terminal.status.connecting")} />
      </div>
    );
  }

  return (
    <div className="h-96 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
      <Terminal
        command={account.loginCommand}
        env={env}
        isActive
        // Al salir la TUI se refresca la lista: si el login funcionó, la fila de la cuenta
        // pasa a mostrar el mail en vez de "sin iniciar sesión".
        onExit={() => { load().catch(console.error); }}
      />
    </div>
  );
}
