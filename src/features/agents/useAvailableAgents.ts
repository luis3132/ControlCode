import { useMemo } from "react";

import { useTabsStore } from "@/features/tabs/store";
import type { AgentInfo } from "@/features/tabs/types";

import { useAgentsStore } from "./store";

/**
 * Las TUIs que se pueden lanzar ahora mismo: las detectadas en el sistema más las que
 * agregó el usuario.
 *
 * Estaba escrito por separado en Home y en el wizard del "+", y las dos copias no
 * filtraban igual — Home descartaba las no instaladas ahí mismo y el wizard se lo dejaba
 * al paso de selección. Que las dos listas se armen acá evita que vuelvan a divergir.
 *
 * Las custom siempre cuentan como disponibles: su comando lo escribió el usuario, así que
 * no hay nada que detectar (si no existe, falla al lanzar, con su mensaje).
 */
export function useAvailableAgents(): AgentInfo[] {
  const detectedAgents = useTabsStore((s) => s.detectedAgents);
  const customAgents = useAgentsStore((s) => s.customAgents);

  return useMemo(
    () =>
      [
        ...detectedAgents,
        ...customAgents.map((ca) => ({
          id: ca.id,
          label: ca.label,
          command: ca.command,
          available: true,
          isCustom: true,
        })),
      ].filter((a) => a.available),
    [detectedAgents, customAgents]
  );
}
