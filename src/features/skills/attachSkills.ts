import { invoke } from "@tauri-apps/api/core";
import { flushPendingSave } from "@/features/tabs/persistence";

/**
 * Monta en una tab recién creada las skills elegidas, y deja la carpeta de skills de su
 * workspace consistente.
 *
 * Existía repetido en los cuatro lugares que crean tabs (Home, el wizard del "+", reanudar
 * una sesión y la CLI), y los tres primeros descartaban los errores con
 * `.catch(console.error)`: si una skill no se podía attachear, la tab arrancaba sin ella y
 * lo único que quedaba era una línea en la consola del webview, que nadie ve. Por eso el
 * síntoma que reportó el usuario era "se abrió sin ninguna skill" y no un mensaje de error.
 *
 * Acá los errores se ACUMULAN y se devuelven: seguir con las demás skills es lo correcto
 * (que una falle no debe dejar la tab sin el resto), pero perderlos no.
 *
 * @returns un mensaje por cada skill que no se pudo montar; vacío si salió todo bien.
 */
export async function attachSkillsToTab(
  tabId: string,
  workspaceId: string,
  skillIds: string[]
): Promise<string[]> {
  // `attach_skill` con scope='tab' busca la tab por id en SQLite, así que la fila tiene
  // que existir antes: el autosave normal tiene 400ms de debounce y no se puede esperar a
  // que le toque.
  await flushPendingSave();

  const errors: string[] = [];
  for (const skillId of skillIds) {
    try {
      await invoke("attach_skill", { skillId, workspaceId, scope: "tab", tabId });
    } catch (e) {
      errors.push(String(e));
    }
  }

  // Best-effort y aparte: esto solo hace que la tab nueva herede las skills que el
  // workspace ya tuviera activas, y que no fallara no es parte de lo que se pidió.
  await invoke("sync_workspace_skills", { workspaceId }).catch(() => {});

  return errors;
}
