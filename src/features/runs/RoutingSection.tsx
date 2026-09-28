import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button } from "neogestify-ui-components";

import { SettingsSection } from "@/features/settings/SettingsSection";

import { getRoster, getTiers, setTiers } from "./ipc";
import { ModelSearch } from "./ModelSearch";
import {
  addToTier, COMPLEXITIES, launchableAgents, moveEarlier, refKey, removeFromTier,
} from "./routingView";
import type { Complexity, ModelRef, Roster, Tiers } from "./types";

/** Lo de fábrica, igual que `Tiers::default` en `routing.rs`. */
const DEFAULT_TIERS: Tiers = {
  trivial: [{ agentId: "claude-code", model: "haiku" }],
  standard: [{ agentId: "claude-code", model: "sonnet" }],
  hard: [{ agentId: "claude-code", model: "opus" }],
};

/**
 * Qué modelo usa la flota según la complejidad que se declara al lanzar.
 *
 * Cada tramo es una lista EN ORDEN y no un modelo solo: si el primero no se puede usar
 * (sin instalar, sin cuenta con cupo), el ruteo pasa al siguiente. Un modelo único
 * obligaría a elegir entre "el mejor" y "el que casi siempre está", y es justo la elección
 * que el ruteo puede hacer en el momento, con el dato de cupo en la mano.
 *
 * Se guarda con cada cambio. Un botón de "guardar" en una lista que se edita de a un click
 * es un paso que se olvida.
 */
export function RoutingSection() {
  const { t } = useTranslation();
  const [tiers, setLocal] = useState<Tiers | null>(null);
  const [roster, setRoster] = useState<Roster | null>(null);
  const [error, setError] = useState("");
  /** El tramo con el buscador abierto para agregarle un modelo. */
  const [adding, setAdding] = useState<Complexity | null>(null);

  useEffect(() => {
    getTiers().then(setLocal).catch((e) => setError(String(e)));
    getRoster().then(setRoster).catch((e) => setError(String(e)));
  }, []);

  const save = async (next: Tiers) => {
    const before = tiers;
    setLocal(next);
    setError("");
    try {
      setLocal(await setTiers(next));
    } catch (e) {
      setLocal(before);
      setError(String(e));
    }
  };

  const edit = (c: Complexity, list: ModelRef[]) => tiers && save({ ...tiers, [c]: list });

  const agents = launchableAgents(roster);
  // Solo lo que hoy se puede correr. Las TUIs instaladas sin adaptador van aparte, dichas:
  // ofrecer sus 89 modelos para que el ruteo los descarte uno por uno sería ruido.
  const pending = roster?.agents.filter((a) => a.installed && !a.launchable) ?? [];
  const labelOf = (ref: ModelRef) => {
    const agent = roster?.agents.find((a) => a.agentId === ref.agentId);
    const model = agent?.models.find((m) => m.id === ref.model);
    return { agent: agent?.label ?? ref.agentId, model: model?.label ?? ref.model };
  };

  return (
    <SettingsSection
      title={t("settings.routing")}
      description={t("settings.routing.desc")}
      action={
        <Button variant="ghost" size="sm" disabled={!tiers} onClick={() => save(DEFAULT_TIERS)}>
          {t("settings.routing.reset")}
        </Button>
      }
    >
      {error && <Alert variant="danger">{error}</Alert>}

      {tiers && (
        <div className="flex flex-col gap-1.5">
          {COMPLEXITIES.map((c) => (
            <div key={c} className="flex items-start gap-3 px-3 py-2 rounded-lg bg-gray-100/70 dark:bg-white/4">
              <span className="flex flex-col gap-px w-28 shrink-0 pt-1">
                <span className="text-[12px] font-medium text-gray-700 dark:text-gray-300">
                  {t(`fleet.complexity.${c}`)}
                </span>
                <span className="text-[10.5px] leading-snug text-gray-400 dark:text-white/30">
                  {t(`settings.routing.${c}Hint`)}
                </span>
              </span>

              <div className="flex flex-wrap items-center gap-1.5 min-w-0 flex-1">
                {tiers[c].map((ref, i) => {
                  const label = labelOf(ref);
                  return (
                    <span
                      key={refKey(ref)}
                      className="flex items-center gap-1 h-7 pl-2 pr-0.5 rounded-md text-[11px]
                        bg-white dark:bg-white/6 border border-gray-200 dark:border-white/10"
                    >
                      {/* El orden ES la preferencia, así que se numera: "1" es a quién va
                          primero, no un adorno. */}
                      <span className="tabular-nums text-[10px] text-gray-400 dark:text-white/30">{i + 1}</span>
                      <span className="font-medium text-gray-800 dark:text-gray-200">{label.model}</span>
                      <span className="text-gray-400 dark:text-white/35">{label.agent}</span>
                      {i > 0 && (
                        <Button variant="custom"
                          onClick={() => edit(c, moveEarlier(tiers[c], i))}
                          aria-label={t("settings.routing.earlier")}
                          title={t("settings.routing.earlier")}
                          className={CHIP_BTN}
                        >
                          ←
                        </Button>
                      )}
                      <Button variant="custom"
                        onClick={() => edit(c, removeFromTier(tiers[c], i))}
                        disabled={tiers[c].length <= 1}
                        aria-label={t("settings.routing.remove")}
                        title={tiers[c].length <= 1 ? t("settings.routing.lastOne") : t("settings.routing.remove")}
                        className={CHIP_BTN}
                      >
                        ×
                      </Button>
                    </span>
                  );
                })}

                {agents.length > 0 && (
                  <Button variant="custom"
                    onClick={() => setAdding(adding === c ? null : c)}
                    aria-expanded={adding === c}
                    className={`cc-t flex items-center gap-1 h-7 px-2 rounded-md text-[11px]
                      border border-dashed border-gray-300 dark:border-white/15
                      ${adding === c
                        ? "text-blue-600 dark:text-blue-400 border-blue-400/60"
                        : "text-gray-500 dark:text-white/45 hover:text-gray-800 dark:hover:text-white"}`}
                  >
                    + {t("settings.routing.add")}
                  </Button>
                )}
                {/* Con buscador y no un `<select>`: con varias TUIs son decenas de modelos, y
                    en la lista había que saber de antemano en cuál estaba el que se quería. */}
                {adding === c && (
                  <div className="w-full pt-1">
                    <ModelSearch
                      agents={agents}
                      value={null}
                      exclude={tiers[c].map((r) => ({ agentId: r.agentId, model: r.model }))}
                      allowDefault={false}
                      autoFocus
                      onEscape={() => setAdding(null)}
                      onChange={(pick) => {
                        edit(c, addToTier(tiers[c], { agentId: pick.agentId, model: pick.model }));
                        setAdding(null);
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {pending.length > 0 && (
        <p className="text-[11px] leading-relaxed text-gray-400 dark:text-white/35">
          {t("settings.routing.pending", { agents: pending.map((a) => a.label).join(", ") })}
        </p>
      )}
    </SettingsSection>
  );
}

const CHIP_BTN = `cc-t flex items-center justify-center gap-0 w-5 h-5 rounded text-[11px]
  text-gray-400 dark:text-white/40
  hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10
  disabled:opacity-30 disabled:hover:bg-transparent`;
