import { useState } from "react";

import { useWorkspacesStore } from "@/features/workspaces/store";
import { SaveWorkspaceDialog } from "@/features/workspaces/SaveWorkspaceDialog";
import { ResetDefaultDialog } from "@/features/workspaces/ResetDefaultDialog";
import { defaultWorkspaceHasContent } from "@/features/workspaces/ipc";

/** Hay un "Nuevo workspace" en marcha en esta ventana, lo haya pedido quien lo haya pedido:
 *  el encabezado, el riel y el selector comparten este freno. */
let creating = false;

/**
 * "Nuevo workspace" y "Guardar workspace", con sus diálogos. Los usan el encabezado del
 * lateral, el riel plegado y el selector de la barra de tabs: cada uno monta `dialogs`.
 */
export function useWorkspaceActions() {
  const resetDefaultWorkspace = useWorkspacesStore((s) => s.resetDefaultWorkspace);
  const [showSave, setShowSave] = useState(false);
  const [showReset, setShowReset] = useState(false);

  // El bucket "default" nunca se guarda con nombre: "Nuevo workspace" simplemente lo
  // vacía y abre una ventana en blanco ahí. Si tiene tabs sin guardar, primero advierte.
  // Un click repetido mientras el primero sigue no hace nada (el backend también lo frena).
  const newWorkspace = async () => {
    if (creating) return;
    creating = true;
    try {
      const hasContent = await defaultWorkspaceHasContent().catch(() => false);
      if (hasContent) setShowReset(true);
      else await resetDefaultWorkspace().catch(console.error);
    } finally {
      creating = false;
    }
  };

  const dialogs = (
    <>
      {showSave && <SaveWorkspaceDialog onClose={() => setShowSave(false)} />}
      {showReset && <ResetDefaultDialog onClose={() => setShowReset(false)} />}
    </>
  );

  return { newWorkspace, saveWorkspace: () => setShowSave(true), dialogs };
}
