import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Modal } from "neogestify-ui-components";
import { useAccountsStore } from "@/features/accounts/store";
import type { AgentAccount } from "@/features/accounts/types";
import { LoginTerminal } from "@/features/accounts/LoginTerminal";
import { AgentPicker } from "@/features/agents/AgentPicker";

interface AddAccountDialogProps {
  /** TUI ya elegida en la sección; el diálogo abre con esa seleccionada. */
  agentId?: string;
  onClose: () => void;
}

/**
 * Alta de una cuenta en dos pasos: elegir TUI + nombre, y después loguearse.
 *
 * El segundo paso es una terminal de verdad, no un formulario de mail y contraseña: el
 * login de estas CLIs es un flujo propio (abre el navegador, pide un código, elige plan) y
 * cambia entre versiones. Reimplementarlo significaría manejar credenciales acá adentro y
 * romperse en la próxima actualización de la TUI. Corriendo el login real, la app nunca ve
 * una credencial y el flujo es exactamente el que documenta cada CLI.
 */
export function AddAccountDialog({ agentId: initialAgentId, onClose }: AddAccountDialogProps) {
  const { t } = useTranslation();
  const capable = useAccountsStore((s) => s.capable);
  const accounts = useAccountsStore((s) => s.accounts);
  const create = useAccountsStore((s) => s.create);
  const load = useAccountsStore((s) => s.load);
  const installed = useMemo(() => capable.filter((c) => c.installed), [capable]);
  const [agentId, setAgentId] = useState(
    initialAgentId && installed.some((c) => c.agentId === initialAgentId)
      ? initialAgentId
      : installed[0]?.agentId ?? ""
  );
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
      <Modal
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
        <p className="text-xs text-gray-500 dark:text-white/50 mb-3">
          {t("settings.accounts.login.helper", { command: created.loginCommand })}
        </p>
        <LoginTerminal account={created} />
      </Modal>
    );
  }

  // ── Paso 1: TUI + nombre ──────────────────────────────────
  return (
    <Modal
      title={t("settings.accounts.add.title")}
      onClose={onClose}
      size="md"
      closeOnBackdrop={!busy}
      closeOnEsc={!busy}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("btn.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !agentId || !name.trim() || taken}
            onClick={handleCreate}
          >
            {t("settings.accounts.add.next")}
          </Button>
        </>
      }
    >
      {installed.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t("settings.accounts.add.noneInstalled")}
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-widest
              text-gray-400 dark:text-gray-500">
              {t("settings.accounts.add.agent")}
            </span>
            <AgentPicker
              value={agentId}
              onChange={setAgentId}
              options={installed.map((c) => ({
                agentId: c.agentId,
                label: c.label,
                hint: c.envVar,
              }))}
            />
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-widest
              text-gray-400 dark:text-gray-500">
              {t("settings.accounts.add.name")}
            </span>
            <Input
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
              error={taken ? t("settings.accounts.add.taken") : undefined}
            />
            <p className="text-[11px] text-gray-400 dark:text-white/40">
              {agent
                ? t("settings.accounts.add.nameHelper", { envVar: agent.envVar })
                : t("settings.accounts.add.nameRules")}
            </p>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-500 dark:text-red-400 mt-3">{error}</p>}
    </Modal>
  );
}
