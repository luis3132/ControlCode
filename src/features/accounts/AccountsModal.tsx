import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AddIcon, Avatar, Badge, Button, EmptyState, InfoIcon, Tooltip, TrashIcon, UserIcon,
} from "neogestify-ui-components";

import { useAccountsStore } from "@/features/accounts/store";
import type { AgentAccount } from "@/features/accounts/types";
import { AddAccountDialog } from "@/features/accounts/AddAccountDialog";
import { LoginTerminal } from "@/features/accounts/LoginTerminal";
import { agentIcon } from "@/features/agents/agentIcons";
import { ShellModal } from "@/shared/ui/ShellModal";
import { AppDialog } from "@/shared/ui/AppDialog";

/** Una cuenta: nombre simbólico, quién está logueado, y qué se puede hacer con ella. */
function AccountRow({ account, onLogin, onDelete }: {
  account: AgentAccount;
  onLogin: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="cc-t group flex items-center gap-3 px-3 h-12 rounded-lg
      bg-white dark:bg-white/4
      hover:bg-gray-50 dark:hover:bg-white/6">

      {/* Iniciales en vez del logo de la TUI: en una lista de cuentas del MISMO servicio,
          repetir su logo en cada fila no distingue nada. El nombre sí — y de paso el
          Avatar deriva de él un color estable por cuenta. El punto de estado dice si
          tiene sesión iniciada. */}
      <Avatar
        name={account.name}
        size="sm"
        shape="square"
        status={account.loggedIn ? "online" : "offline"}
      />

      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-[12.5px] font-semibold text-gray-800 dark:text-gray-100">
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
          <span className="truncate text-[10.5px] text-gray-400 dark:text-white/35">
            {account.label ?? (account.loggedIn
              ? t("settings.accounts.loggedIn")
              : t("settings.accounts.pendingLogin"))}
          </span>
        </Tooltip>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <Button
          variant={account.loggedIn ? "outline" : "primary"}
          size="sm"
          onClick={onLogin}
        >
          {account.loggedIn
            ? t("settings.accounts.relogin")
            : t("settings.accounts.login.btn")}
        </Button>
        <Tooltip content={t("settings.accounts.delete.action")} placement="left">
          <button
            onClick={onDelete}
            aria-label={t("settings.accounts.delete.action")}
            className="cc-t flex items-center justify-center w-7 h-7 rounded-md shrink-0
              text-gray-400 dark:text-white/35
              hover:text-red-500 dark:hover:text-red-400
              hover:bg-gray-200 dark:hover:bg-white/10"
          >
            <TrashIcon className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

/**
 * Las cuentas de la app, en su propia pantalla.
 *
 * Vivían adentro de Configuración, entre el directorio de skills y los comandos previos.
 * Están acá porque no son un ajuste: son algo que se administra, crece y se consulta — y
 * el riel ya les daba un botón propio que abría Configuración y hacía scroll hasta ellas.
 *
 * La columna de la izquierda son los SERVICIOS. Hoy son las TUIs que soportan varias
 * cuentas, pero la estructura es la misma para cualquier otra cosa que pida iniciar sesión
 * más adelante: agregar un servicio es agregar una entrada a esa lista, no rehacer la
 * pantalla.
 */
export function AccountsModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const accounts = useAccountsStore((s) => s.accounts);
  const capable = useAccountsStore((s) => s.capable);
  const loaded = useAccountsStore((s) => s.loaded);
  const load = useAccountsStore((s) => s.load);
  const remove = useAccountsStore((s) => s.remove);
  const [agentId, setAgentId] = useState("");
  const [adding, setAdding] = useState(false);
  const [loginFor, setLoginFor] = useState<AgentAccount | null>(null);
  const [deleting, setDeleting] = useState<AgentAccount | null>(null);
  const [error, setError] = useState("");

  useEffect(() => { load().catch((e) => setError(String(e))); }, [load]);

  /** Servicios que se muestran: los instalados, más los que ya tengan cuentas creadas
   *  (para no esconder cuentas existentes si la TUI se desinstaló). */
  const shown = useMemo(
    () => capable.filter((c) => c.installed || accounts.some((a) => a.agentId === c.agentId)),
    [capable, accounts]
  );

  // Se elige el primero solo: la pantalla arranca mostrando algo en vez de un hueco que
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
    <ShellModal
      title={t("settings.accounts")}
      icon={<UserIcon className="w-[15px] h-[15px] shrink-0 text-blue-500 dark:text-blue-400" />}
      width="max-w-3xl"
      onClose={onClose}
    >
      {/* ══ los servicios ═════════════════════════════════════════════════ */}
      <nav className="flex flex-col w-48 shrink-0 min-h-0
        border-r border-gray-200 dark:border-white/8
        bg-gray-100/50 dark:bg-black/20">
        <span className="shrink-0 px-3 pt-3 pb-1.5 text-[9.5px] font-extrabold uppercase
          tracking-[0.11em] text-gray-400 dark:text-white/30">
          {t("accounts.services")}
        </span>
        <div className="flex-1 min-h-0 cc-scroll px-1.5 pb-2">
          {shown.map((c) => {
            const Icon = agentIcon(c.agentId, c.label);
            const n = accounts.filter((a) => a.agentId === c.agentId).length;
            const active = c.agentId === agentId;
            return (
              <button
                key={c.agentId}
                onClick={() => setAgentId(c.agentId)}
                // El número solo no dice qué cuenta: al lado de un nombre puede leerse como
                // una versión o un índice. Acá `count` SÍ es lo que se quiere — la clave
                // tiene formas _one/_other y es i18next quien elige.
                title={t("settings.accounts.count", { count: n })}
                className={`cc-t flex items-center gap-2 w-full h-8 px-2 rounded-lg text-left
                  ${active
                    ? "bg-blue-500/12 dark:bg-blue-400/13 text-gray-900 dark:text-white font-semibold"
                    : "text-gray-600 dark:text-gray-400 hover:bg-gray-200/60 dark:hover:bg-white/6"}`}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span className="flex-1 min-w-0 truncate text-[11.5px]">{c.label}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-white/30">
                  {n || ""}
                </span>
              </button>
            );
          })}
        </div>
        {/* Las TUIs instaladas que NO aparecen acá tienen un motivo, y decirlo evita que se
            lea como un olvido. */}
        <p className="shrink-0 px-3 py-2 text-[10px] leading-relaxed
          border-t border-gray-200 dark:border-white/8
          text-gray-400 dark:text-white/30">
          {t("settings.accounts.unsupportedNote")}
        </p>
      </nav>

      {/* ══ sus cuentas ═══════════════════════════════════════════════════ */}
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        {loaded && shown.length === 0 ? (
          <EmptyState
            className="m-auto"
            icon={<UserIcon className="w-8 h-8" />}
            title={t("settings.accounts.noneInstalled")}
          />
        ) : selected && (
          <>
            <div className="flex items-center gap-2 h-9 shrink-0 px-4
              border-b border-gray-200 dark:border-white/8">
              <span className="flex-1 min-w-0 truncate text-[11.5px] font-semibold
                text-gray-700 dark:text-gray-300">
                {t("settings.accounts.of", { agent: selected.label })}
              </span>
              <Badge variant="info" size="sm" className="font-mono shrink-0">
                {selected.envVar}
              </Badge>
              <Tooltip content={t("settings.accounts.add")} placement="bottom">
                <button
                  onClick={() => setAdding(true)}
                  disabled={!selected.installed}
                  aria-label={t("settings.accounts.add")}
                  className="cc-t flex items-center justify-center w-6 h-6 rounded-md shrink-0
                    text-gray-400 dark:text-white/35
                    hover:text-gray-700 dark:hover:text-white
                    hover:bg-gray-200 dark:hover:bg-white/10
                    disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <AddIcon className="w-3.5 h-3.5" />
                </button>
              </Tooltip>
            </div>

            <div className="flex-1 min-h-0 cc-scroll flex flex-col gap-1.5 p-3">
              {rows.length === 0 ? (
                <EmptyState
                  className="m-auto"
                  icon={<UserIcon className="w-7 h-7" />}
                  title={t("settings.accounts.emptyForAgent")}
                  action={
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={!selected.installed}
                      onClick={() => setAdding(true)}
                    >
                      {t("settings.accounts.add")}
                    </Button>
                  }
                />
              ) : (
                rows.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    onLogin={() => setLoginFor(account)}
                    onDelete={() => setDeleting(account)}
                  />
                ))
              )}
            </div>

            {error && (
              <p className="shrink-0 px-4 pb-2 text-[11px] text-red-500 dark:text-red-400">
                {error}
              </p>
            )}

            {/* La cuenta del sistema siempre está y no se administra desde acá: es la que
                usan las tabs que no eligen ninguna, y borrarla desde la app sería borrar
                el login que el usuario hizo por fuera. */}
            <div className="flex items-start gap-2 shrink-0 px-4 py-2
              border-t border-gray-200 dark:border-white/8
              bg-gray-100/60 dark:bg-black/20
              text-[10.5px] text-gray-400 dark:text-white/35">
              <InfoIcon className="w-3.5 h-3.5 mt-px shrink-0" />
              <span>{t("settings.accounts.systemDefault")}</span>
            </div>
          </>
        )}
      </div>

      {adding && (
        <AddAccountDialog agentId={agentId} onClose={() => setAdding(false)} />
      )}

      {loginFor && (
        <AppDialog
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
        </AppDialog>
      )}

      {deleting && (
        <AppDialog
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
        </AppDialog>
      )}
    </ShellModal>
  );
}
