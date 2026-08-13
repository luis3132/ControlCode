import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Avatar, Badge, Button, Modal, Tooltip, AddIcon, TrashIcon, InfoIcon,
} from "neogestify-ui-components";
import { useAccountsStore } from "@/features/accounts/store";
import type { AgentAccount } from "@/features/accounts/types";
import { AddAccountDialog } from "@/features/accounts/AddAccountDialog";
import { LoginTerminal } from "@/features/accounts/LoginTerminal";
import { AgentPicker } from "@/features/agents/AgentPicker";

/** Una cuenta: nombre simbólico, quién está logueado, y qué se puede hacer con ella. */
function AccountRow({
  account,
  onLogin,
  onDelete,
}: {
  account: AgentAccount;
  onLogin: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="group flex items-center justify-between gap-3 px-4 py-3
      rounded-xl border border-gray-200 dark:border-gray-700
      bg-gray-50/60 dark:bg-white/[0.02]
      hover:border-gray-300 dark:hover:border-gray-600 transition-colors">

      <div className="flex items-center gap-3 min-w-0">
        {/* Iniciales en vez del logo de la TUI: en una lista de cuentas del MISMO agente,
            repetir su logo en cada fila no distingue nada. El nombre sí — y de paso el
            Avatar deriva de él un color estable por cuenta. El punto de estado dice si
            tiene sesión iniciada. */}
        <Avatar
          name={account.name}
          size="sm"
          shape="square"
          status={account.loggedIn ? "online" : "offline"}
        />

        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">
              {account.name}
            </span>
            {!account.loggedIn && (
              <Badge variant="warning" size="sm" className="shrink-0">
                {t("settings.accounts.notLoggedIn")}
              </Badge>
            )}
          </div>
          {/* Cuando la TUI expone el mail se muestra: es lo que de verdad distingue una
              cuenta de otra — el nombre simbólico lo eligió el usuario y puede mentir.
              La ruta del perfil va en el tooltip: hace falta para depurar, pero mostrarla
              en cada fila llenaba la lista de texto que nadie lee. */}
          <Tooltip content={`${account.envVar}=${account.dir}`} placement="bottom">
            <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {account.label ?? (account.loggedIn
                ? t("settings.accounts.loggedIn")
                : t("settings.accounts.pendingLogin"))}
            </span>
          </Tooltip>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant={account.loggedIn ? "outline" : "primary"}
          onClick={onLogin}
          className="text-xs! h-8! px-3!"
        >
          {account.loggedIn
            ? t("settings.accounts.relogin")
            : t("settings.accounts.login.btn")}
        </Button>
        <Button variant="outline" onClick={onDelete} className="h-8! px-2.5!">
          <TrashIcon className="w-3.5 h-3.5 text-red-500" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Varias cuentas de la misma TUI, sin desloguearse cada vez.
 *
 * Cada cuenta es un directorio de perfil propio dentro de los datos de la app; lanzar una
 * TUI con la variable apuntada ahí la hace correr con esa cuenta. Ver `accounts` en Rust
 * para por qué es una variable de entorno y no un symlink.
 */
export function AccountsSection() {
  const { t } = useTranslation();
  const { accounts, capable, loaded, load, remove } = useAccountsStore();
  const [agentId, setAgentId] = useState("");
  const [adding, setAdding] = useState(false);
  const [loginFor, setLoginFor] = useState<AgentAccount | null>(null);
  const [deleting, setDeleting] = useState<AgentAccount | null>(null);
  const [error, setError] = useState("");

  useEffect(() => { load().catch((e) => setError(String(e))); }, [load]);

  /** TUIs que se muestran: las instaladas, más las que ya tengan cuentas creadas (para no
   *  esconder cuentas existentes si la TUI se desinstaló). */
  const shown = useMemo(
    () => capable.filter((c) => c.installed || accounts.some((a) => a.agentId === c.agentId)),
    [capable, accounts]
  );

  // Se elige la primera sola: la sección arranca mostrando algo en vez de un hueco que
  // obliga a un click antes de que haya nada que ver.
  useEffect(() => {
    if (!agentId && shown.length > 0) setAgentId(shown[0].agentId);
  }, [agentId, shown]);

  const selected = shown.find((c) => c.agentId === agentId);
  const rows = useMemo(
    () => accounts.filter((a) => a.agentId === agentId),
    [accounts, agentId]
  );

  const handleDelete = async (deleteFiles: boolean) => {
    if (!deleting) return;
    try {
      await remove(deleting.id, deleteFiles);
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <section className="bg-linear-to-br from-white to-gray-50
      dark:from-gray-800 dark:to-gray-900
      rounded-xl border border-gray-200 dark:border-gray-700
      shadow-sm hover:shadow-md transition-shadow duration-300 p-6">

      <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-1">
        {t("settings.accounts")}
      </h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
        {t("settings.accounts.desc")}
      </p>

      {loaded && shown.length === 0 ? (
        <p className="text-sm italic text-gray-400 dark:text-gray-500">
          {t("settings.accounts.noneInstalled")}
        </p>
      ) : (
        <div className="flex flex-col gap-6">

          {/* Paso 1: qué TUI. Mismas tarjetas que el Home. */}
          <div className="flex flex-col gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-widest
              text-gray-400 dark:text-gray-500">
              {t("settings.accounts.pickAgent")}
            </span>
            <AgentPicker
              value={agentId}
              onChange={setAgentId}
              options={shown.map((c) => ({
                agentId: c.agentId,
                label: c.label,
                // Acá `count` SÍ es lo que se quiere: la clave tiene formas _one/_other y
                // es i18next quien elige (a diferencia de `orchestrator.tooltip`, donde el
                // plural rompía y por eso la variable se llama distinto).
                hint: t("settings.accounts.count", {
                  count: accounts.filter((a) => a.agentId === c.agentId).length,
                }),
              }))}
            />
            {/* Las TUIs instaladas que NO aparecen acá tienen un motivo, y decirlo evita
                que se lea como un olvido. */}
            <p className="text-[11px] text-gray-400 dark:text-white/40">
              {t("settings.accounts.unsupportedNote")}
            </p>
          </div>

          {/* Paso 2: sus cuentas. */}
          {selected && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] font-semibold uppercase tracking-widest
                  text-gray-400 dark:text-gray-500">
                  {t("settings.accounts.of", { agent: selected.label })}
                </span>
                <Badge variant="info" size="sm" className="font-mono">
                  {selected.envVar}
                </Badge>
              </div>

              {rows.length === 0 ? (
                <p className="text-sm italic text-gray-400 dark:text-gray-500">
                  {t("settings.accounts.emptyForAgent")}
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {rows.map((account) => (
                    <AccountRow
                      key={account.id}
                      account={account}
                      onLogin={() => setLoginFor(account)}
                      onDelete={() => setDeleting(account)}
                    />
                  ))}
                </div>
              )}

              <div>
                <Button
                  variant="outline"
                  onClick={() => setAdding(true)}
                  disabled={!selected.installed}
                  className="flex items-center gap-1.5 text-xs! h-8! px-3!"
                >
                  <AddIcon className="w-3.5 h-3.5" />
                  {t("settings.accounts.add")}
                </Button>
              </div>

              {/* La cuenta del sistema siempre está y no se administra desde acá: es la que
                  usan las tabs que no eligen ninguna, y borrarla desde la app sería borrar
                  el login que el usuario hizo por fuera. */}
              <div className="flex items-start gap-2 text-[11px]
                text-gray-400 dark:text-white/40">
                <InfoIcon className="w-3.5 h-3.5 mt-px shrink-0" />
                <span>{t("settings.accounts.systemDefault")}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-xs text-red-500 dark:text-red-400 mt-3">{error}</p>}

      {adding && (
        <AddAccountDialog agentId={agentId} onClose={() => setAdding(false)} />
      )}

      {loginFor && (
        <Modal
          title={t("settings.accounts.login.title", { name: loginFor.name })}
          onClose={() => setLoginFor(null)}
          size="lg"
          closeOnBackdrop={false}
          closeOnEsc={false}
          footer={
            <Button variant="primary" onClick={() => { setLoginFor(null); load(); }}>
              {t("settings.accounts.login.done")}
            </Button>
          }
        >
          <p className="text-xs text-gray-500 dark:text-white/50 mb-3">
            {t("settings.accounts.login.helper", { command: loginFor.loginCommand })}
          </p>
          <LoginTerminal account={loginFor} />
        </Modal>
      )}

      {deleting && (
        <Modal
          title={t("settings.accounts.delete.title", { name: deleting.name })}
          onClose={() => setDeleting(null)}
          size="sm"
          footer={
            <>
              <Button variant="outline" onClick={() => setDeleting(null)}>
                {t("btn.cancel")}
              </Button>
              {/* Dos salidas distintas a propósito: quitarla de la app es reversible
                  (se vuelve a agregar con el mismo nombre y el login sigue ahí), borrar la
                  carpeta con las credenciales no lo es. */}
              <Button variant="outline" onClick={() => handleDelete(false)}>
                {t("settings.accounts.delete.keepFiles")}
              </Button>
              <Button variant="danger" onClick={() => handleDelete(true)}>
                {t("settings.accounts.delete.withFiles")}
              </Button>
            </>
          }
        >
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t("settings.accounts.delete.body")}
          </p>
          <code className="block mt-2 text-[11px] font-mono break-all
            text-gray-500 dark:text-gray-400">
            {deleting.dir}
          </code>
        </Modal>
      )}
    </section>
  );
}
