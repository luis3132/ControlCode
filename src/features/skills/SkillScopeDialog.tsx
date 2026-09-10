import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Modal } from "neogestify-ui-components";

import { useSkillsStore } from "@/features/skills/store";
import { SkillPickerStep } from "@/features/tabs/wizard/SkillPickerStep";
import type { SkillSummary } from "@/features/skills/types";

export interface SkillScopeTarget {
  scope: "workspace" | "tab";
  workspaceId: string;
  /** Solo con `scope: "tab"`. */
  tabId?: string;
  /** Solo con `scope: "workspace"`: la carpeta. Es lo que hace que la skill valga en ESE
   *  workspace y no en los otros que estén abiertos en la misma ventana. */
  cwd?: string;
  /** Para filtrar el catálogo por TUI. `null` en scope de workspace. */
  agentId: string | null;
  /** Qué se está editando, para el título. */
  label: string;
}

/** Las que YA están adjuntas en este alcance, según `usedBy`. */
function attachedIn(skills: SkillSummary[], target: SkillScopeTarget): string[] {
  return skills
    .filter((skill) =>
      skill.usedBy.some((use) =>
        target.scope === "tab"
          ? use.scope === "tab" && use.tabId === target.tabId
          : use.scope === "workspace"
            && use.workspaceId === target.workspaceId
            && use.cwd === (target.cwd ?? "")
      )
    )
    .map((skill) => skill.id);
}

/**
 * Elegir las skills de un alcance, con el mismo selector que el wizard.
 *
 * Las del WORKSPACE valen para todos los agentes de esa carpeta; las de una TAB, solo
 * para ese agente. Se llega por click derecho en el panel izquierdo — sobre el workspace
 * o sobre el agente — porque es ahí donde ya se ve a qué pertenece cada cosa.
 *
 * Confirmar hace el diff contra lo que había: se adjunta lo que se agregó y se desmonta
 * lo que se sacó. Enviar todo de nuevo recrearía symlinks que ya estaban bien y, en las
 * TUIs que solo escanean al arrancar, no cambiaría nada mientras las molesta igual.
 */
export function SkillScopeDialog({ target, onClose }: { target: SkillScopeTarget; onClose: () => void }) {
  const { t } = useTranslation();
  const skills = useSkillsStore((s) => s.skills);
  const attachSkill = useSkillsStore((s) => s.attachSkill);
  const detachSkill = useSkillsStore((s) => s.detachSkill);

  const initial = useMemo(() => attachedIn(skills, target), [skills, target]);
  const [selected, setSelected] = useState<string[]>(initial);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const added = selected.filter((id) => !initial.includes(id));
  const removed = initial.filter((id) => !selected.includes(id));
  const dirty = added.length > 0 || removed.length > 0;

  const handleConfirm = async () => {
    setBusy(true);
    const failed: string[] = [];
    // Se sigue con las demás si una falla: que no se pueda montar una skill no es motivo
    // para dejar al agente sin el resto. Los errores se acumulan y se muestran.
    for (const id of added) {
      try {
        await attachSkill(id, target.workspaceId, target.scope, target.tabId, target.cwd);
      } catch (e) {
        failed.push(String(e));
      }
    }
    for (const id of removed) {
      try {
        await detachSkill(id, target.workspaceId, target.scope, target.tabId, target.cwd);
      } catch (e) {
        failed.push(String(e));
      }
    }
    setBusy(false);
    if (failed.length > 0) setErrors(failed);
    else onClose();
  };

  return (
    <Modal
      title={t(target.scope === "tab" ? "skills.scope.tabTitle" : "skills.scope.workspaceTitle", {
        name: target.label,
      })}
      onClose={onClose}
      size="md"
      closeOnBackdrop={!busy}
      closeOnEsc={!busy}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("btn.cancel")}
          </Button>
          <Button variant="primary" disabled={busy || !dirty} onClick={handleConfirm}>
            {t("skills.scope.confirm")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t(target.scope === "tab" ? "skills.scope.tabHelp" : "skills.scope.workspaceHelp")}
        </p>

        <SkillPickerStep agentId={target.agentId} selected={selected} onChange={setSelected} />

        {/* Se avisa que el agente ya corriendo puede no enterarse: varias TUIs escanean su
            carpeta de skills solo al arrancar, así que el symlink existe pero no se usa. */}
        {dirty && target.scope === "tab" && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {t("skills.scope.restartHint")}
          </p>
        )}

        {errors.length > 0 && (
          <ul className="flex flex-col gap-1 text-xs text-red-600 dark:text-red-400">
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
      </div>
    </Modal>
  );
}
