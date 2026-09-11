import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge, Button, Input,
} from "neogestify-ui-components";

import { useAccountsStore } from "@/features/accounts/store";
import type { AgentAccount } from "@/features/accounts/types";
import { LoginTerminal } from "@/features/accounts/LoginTerminal";
import { agentIcon } from "@/features/agents/agentIcons";
import { AppDialog } from "@/shared/ui/AppDialog";

interface AddAccountDialogProps {
  /** El servicio para el que se crea. Viene de la sección en la que estás parado, y no se
   *  vuelve a preguntar: ya lo elegiste al entrar ahí. */
  agentId: string;
  onClose: () => void;
}

/**
 * Alta de una cuenta: ponerle nombre y loguearse.
 *
 * Antes preguntaba OTRA VEZ de qué TUI era, con un selector igual al de la pantalla desde
 * la que se abre. Estando en la sección de Claude Code, el botón de agregar solo puede
 * querer decir una cosa — y peor, el selector dejaba crear la cuenta en otro servicio y
 * aparecer en una sección distinta de la que estabas mirando.
 *
 * El login es una terminal de verdad y no un formulario de mail y contraseña: el de estas
 * CLIs es un flujo propio (abre el navegador, pide un código, elige plan) y cambia entre
 * versiones. Reimplementarlo significaría manejar credenciales acá adentro y romperse en la
 * próxima actualización de la TUI. Corriendo el login real, la app nunca ve una credencial.
 */
export function AddAccountDialog({ agentId, onClose }: AddAccountDialogProps) {
  const { t } = useTranslation();
  const capable = useAccountsStore((s) => s.capable);
  const accounts = useAccountsStore((s) => s.accounts);
  const create = useAccountsStore((s) => s.create);
  const load = useAccountsStore((s) => s.load);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** Cuenta ya creada: pasamos a la terminal de login. */
  const [created, setCreated] = useState<AgentAccount | null>(null);

  const agent = capable.find((c) => c.agentId === agentId);
  const taken = accounts.some((a) => a.agentId === agentId && a.name === name.trim());

  const handleCreate = async () => {
    setBusy(true);
    setError("");
    try {
      setCreated(await create(agentId, name.trim()));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // ── Paso 2: login ─────────────────────────────────────────
  if (created) {
    return (
      <AppDialog
        title={t("settings.accounts.login.title", { name: created.name })}
        onClose={onClose}
        size="lg"
        // Cerrar sin querer a mitad de un login (un click fuera, un Esc) deja la cuenta
        // creada pero vacía, y desde afuera parece que "no funcionó". Se sale por el botón.
        closeOnBackdrop={false}
        closeOnEsc={false}
        footer={
          <Button
            variant="primary"
            onClick={async () => {
              await load();
              onClose();
            }}
          >
            {t("settings.accounts.login.done")}
          </Button>
        }
      >
        <p className="text-[11.5px] text-gray-500 dark:text-white/45 mb-3">
          {t("settings.accounts.login.helper", { command: created.loginCommand })}
        </p>
        <LoginTerminal account={created} />
      </AppDialog>
    );
  }

  // ── Paso 1: el nombre ─────────────────────────────────────
  const Icon = agent ? agentIcon(agent.agentId, agent.label) : null;

  return (
    <AppDialog
      title={agent
        ? t("settings.accounts.add.titleFor", { agent: agent.label })
        : t("settings.accounts.add.title")}
      onClose={onClose}
      size="sm"
      closeOnBackdrop={!busy}
      closeOnEsc={!busy}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("btn.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !agent || !name.trim() || taken}
            onClick={handleCreate}
          >
            {t("settings.accounts.add.next")}
          </Button>
        </>
      }
    >
      {!agent ? (
        <p className="text-[12px] text-gray-500 dark:text-gray-400">
          {t("settings.accounts.add.noneInstalled")}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Para qué servicio es. Va como dato, no como elección: es lo que estabas
              mirando, y decirlo acá evita tener que confiar en haber leído el título. */}
          <div className="flex items-center gap-2 h-9 px-3 rounded-lg
            bg-gray-100/70 dark:bg-white/4">
            {Icon && <Icon className="w-3.5 h-3.5 shrink-0 text-gray-500 dark:text-gray-400" />}
            <span className="flex-1 min-w-0 truncate text-[12px]
              text-gray-700 dark:text-gray-300">
              {agent.label}
            </span>
            <Badge variant="info" size="sm" className="font-mono shrink-0">
              {agent.envVar}
            </Badge>
          </div>

          <Input
            label={t("settings.accounts.add.name")}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim() && !taken && !busy) handleCreate();
            }}
            placeholder="trabajo"
            variant="outline"
            autoFocus
            error={taken ? t("settings.accounts.add.taken") : undefined}
            helperText={t("settings.accounts.add.nameHelper", { envVar: agent.envVar })}
          />
        </div>
      )}

      {error && (
        <p className="mt-3 text-[11.5px] text-red-500 dark:text-red-400">{error}</p>
      )}
    </AppDialog>
  );
}
