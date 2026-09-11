/**
 * Qué tabs pertenecen al workspace en el que estás parado.
 *
 * Un workspace es una carpeta: sus agentes son las tabs con ese mismo `cwd`. Vive acá y
 * no dentro de un componente porque lo usan la barra de tabs y los atajos de teclado, y
 * si cada uno decidiera por su cuenta, Ctrl+Tab saltaría a una tab que no está a la vista.
 */
import type { Tab } from "@/features/tabs/types";

export function tabsOfWorkspace(tabs: Tab[], activeTabId: string | null): Tab[] {
  const active = tabs.find((tab) => tab.id === activeTabId);
  // Sin tab activa no hay workspace del que hablar: se muestran todas en vez de ninguna,
  // que es lo que pasa justo después de cerrar la última de una carpeta.
  if (!active) return tabs;
  return tabs.filter((tab) => tab.cwd === active.cwd);
}
