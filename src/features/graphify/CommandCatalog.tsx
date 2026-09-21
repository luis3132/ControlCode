import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimateSpin, Button, Input, Select } from "neogestify-ui-components";

import {
  graphifyCommands, graphifyRender, type GraphifyChoice, type GraphifyCommand, type GraphifyRun,
} from "./ipc";
import { agentTabs, runInTerminal, sendToAgent } from "./send";

/** El orden de los grupos en la interfaz. Uno que no esté acá va al final, no se pierde. */
const GROUPS = ["build", "query", "export", "hooks", "alwaysOn", "prs", "global", "memory", "server", "uninstall", "skill"];

const emptyChoice = (): GraphifyChoice => ({ flags: [], args: {} });

/** Los huecos que el comando usa AHORA: los de la base más los de los flags prendidos. */
function visibleArgs(command: GraphifyCommand, choice: GraphifyChoice): string[] {
  const used = new Set<string>();
  const scan = (text: string) => {
    for (const match of text.matchAll(/\{(\w+)\}/g)) used.add(match[1]);
  };
  scan(command.template);
  for (const flag of command.flags) {
    if (choice.flags.includes(flag.id)) scan(flag.text);
  }
  return command.args.filter((a) => used.has(a.name)).map((a) => a.name);
}

/**
 * Todo lo que graphify sabe hacer, como una lista con sus flags.
 *
 * La tabla vive en el backend (`src-tauri/src/graphify/catalog.rs`) y acá se dibuja sola:
 * agregar un comando es agregar una fila allá, no una pantalla acá. El comando final
 * también lo arma el backend, así que **lo que se muestra es exactamente lo que se
 * ejecuta** — si se armaran por separado, un día dirían cosas distintas.
 *
 * Tres destinos, según qué sea el comando:
 * - de shell y corto: se ejecuta y su salida vuelve acá;
 * - de shell y sin fin (`watch`, el servidor MCP): va a una terminal, donde se lo ve correr;
 * - del asistente (`/graphify .`): no existe como binario, así que se escribe en la
 *   terminal de un agente.
 */
export function CommandCatalog({ cwd, onRun }: {
  cwd: string;
  onRun: (command: string) => Promise<GraphifyRun>;
}) {
  const { t } = useTranslation();
  const [commands, setCommands] = useState<GraphifyCommand[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, GraphifyChoice>>({});
  const [preview, setPreview] = useState<Record<string, string>>({});
  const [runs, setRuns] = useState<Record<string, GraphifyRun>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string>("");
  const [note, setNote] = useState("");

  useEffect(() => { graphifyCommands().then(setCommands).catch(() => setCommands([])); }, []);

  const agents = useMemo(() => agentTabs(cwd), [cwd]);
  useEffect(() => {
    if (!agents.some((a) => a.id === agentId)) setAgentId(agents[0]?.id ?? "");
  }, [agents, agentId]);

  const choiceOf = useCallback((id: string) => choices[id] ?? emptyChoice(), [choices]);

  /** El comando final lo arma el backend cada vez que cambia algo de la fila. */
  const refresh = useCallback(async (id: string, choice: GraphifyChoice) => {
    try {
      const line = await graphifyRender(id, choice);
      setPreview((prev) => ({ ...prev, [id]: line }));
    } catch {
      /* Una fila que no se puede armar simplemente no muestra vista previa. */
    }
  }, []);

  const update = (id: string, next: GraphifyChoice) => {
    setChoices((prev) => ({ ...prev, [id]: next }));
    refresh(id, next);
  };

  const open = (command: GraphifyCommand) => {
    const id = command.id;
    setOpenId((prev) => (prev === id ? null : id));
    if (preview[id] === undefined) refresh(id, choiceOf(id));
  };

  const toggleFlag = (command: GraphifyCommand, flagId: string) => {
    const choice = choiceOf(command.id);
    const flags = choice.flags.includes(flagId)
      ? choice.flags.filter((f) => f !== flagId)
      : [...choice.flags, flagId];
    update(command.id, { ...choice, flags });
  };

  const setArg = (command: GraphifyCommand, name: string, value: string) => {
    const choice = choiceOf(command.id);
    update(command.id, { ...choice, args: { ...choice.args, [name]: value } });
  };

  const execute = async (command: GraphifyCommand) => {
    const line = preview[command.id];
    if (!line) return;
    setBusy(command.id);
    setNote("");
    try {
      const result = await onRun(line);
      setRuns((prev) => ({ ...prev, [command.id]: result }));
    } finally {
      setBusy(null);
    }
  };

  const toTerminal = (command: GraphifyCommand) => {
    const line = preview[command.id];
    if (!line) return;
    runInTerminal(line, cwd || ".", `graphify ${command.id}`);
    setNote(t("settings.graphify.sentToTerminal"));
  };

  const toAgent = (command: GraphifyCommand) => {
    const line = preview[command.id];
    if (!line || !agentId) return;
    setNote(sendToAgent(agentId, line)
      ? t("settings.graphify.sentToAgent")
      : t("settings.graphify.agentNotReady"));
  };

  const grouped = useMemo(() => {
    const byGroup = new Map<string, GraphifyCommand[]>();
    for (const command of commands) {
      byGroup.set(command.group, [...(byGroup.get(command.group) ?? []), command]);
    }
    const known = GROUPS.filter((g) => byGroup.has(g));
    const rest = [...byGroup.keys()].filter((g) => !GROUPS.includes(g));
    return [...known, ...rest].map((group) => [group, byGroup.get(group) ?? []] as const);
  }, [commands]);

  return (
    <div className="flex flex-col gap-4">
      {note && <p className="text-[11px] text-gray-500 dark:text-white/40">{note}</p>}

      {grouped.map(([group, items]) => (
        <div key={group} className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide
            text-gray-400 dark:text-white/30">
            {t(`settings.graphify.group.${group}`)}
          </span>

          {items.map((command) => {
            const isOpen = openId === command.id;
            const choice = choiceOf(command.id);
            const line = preview[command.id] ?? command.template;
            const run = runs[command.id];
            return (
              <div key={command.id} className="flex flex-col rounded-lg overflow-hidden
                bg-gray-100/70 dark:bg-white/4">
                <button
                  onClick={() => open(command)}
                  className="cc-t flex items-center gap-2.5 w-full px-3 py-2 text-left
                    hover:bg-gray-100 dark:hover:bg-white/6"
                >
                  <span className="flex flex-col gap-px min-w-0 flex-1">
                    <span className="truncate font-mono text-[11px]
                      text-gray-800 dark:text-gray-100">
                      {isOpen ? line : command.template}
                    </span>
                    <span className="truncate text-[10.5px] text-gray-400 dark:text-white/35">
                      {t(`settings.graphify.cmd.${command.id}`)}
                    </span>
                  </span>
                  {command.kind === "skill" && (
                    <span className="shrink-0 px-1.5 rounded text-[9.5px]
                      bg-blue-500/10 text-blue-600 dark:bg-blue-400/15 dark:text-blue-300">
                      {t("settings.graphify.inAssistant")}
                    </span>
                  )}
                </button>

                {isOpen && (
                  <div className="flex flex-col gap-2 px-3 pb-3">
                    {visibleArgs(command, choice).map((name) => {
                      const arg = command.args.find((a) => a.name === name);
                      if (!arg) return null;
                      const value = choice.args[name] ?? arg.default;
                      return (
                        <label key={name} className="flex items-center gap-2">
                          <span className="w-24 shrink-0 text-[10.5px]
                            text-gray-500 dark:text-white/40">
                            {t(`settings.graphify.arg.${name}`, name)}
                          </span>
                          {arg.options.length > 0 ? (
                            <Select
                              value={value}
                              onChange={(e) => setArg(command, name, e.target.value)}
                              variant="minimal"
                              size="sm"
                              options={arg.options.map((o) => ({ value: o, label: o }))}
                            />
                          ) : (
                            <Input
                              value={value}
                              onChange={(e) => setArg(command, name, e.target.value)}
                              variant="minimal"
                              size="sm"
                              className="flex-1 !font-mono !text-[11px]"
                              spellCheck={false}
                            />
                          )}
                        </label>
                      );
                    })}

                    {command.flags.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {command.flags.map((flag) => (
                          <button
                            key={flag.id}
                            onClick={() => toggleFlag(command, flag.id)}
                            className={`cc-t px-2 py-0.5 rounded font-mono text-[10px]
                              ${choice.flags.includes(flag.id)
                                ? "bg-blue-500/12 dark:bg-blue-400/13 text-gray-800 dark:text-white"
                                : "bg-gray-100 dark:bg-white/5 text-gray-500 dark:text-white/40 hover:bg-gray-200 dark:hover:bg-white/10"}`}
                          >
                            {flag.text.replace(/\{\w+\}/g, "…")}
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                      {command.kind === "skill" ? (
                        <>
                          <Select
                            value={agentId}
                            onChange={(e) => setAgentId(e.target.value)}
                            variant="minimal"
                            size="sm"
                            options={agents.map((a) => ({ value: a.id, label: a.title }))}
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!agentId}
                            onClick={() => toAgent(command)}
                          >
                            {t("settings.graphify.toAgent")}
                          </Button>
                        </>
                      ) : (
                        <>
                          {/* Los que no terminan solos no se ejecutan con la salida
                              capturada: la app esperaría hasta el tope de tiempo. */}
                          {!command.longRunning && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy !== null}
                              onClick={() => execute(command)}
                              leftIcon={busy === command.id ? <AnimateSpin className="w-3.5 h-3.5" /> : undefined}
                            >
                              {t("settings.graphify.run")}
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" onClick={() => toTerminal(command)}>
                            {t("settings.graphify.toTerminal")}
                          </Button>
                        </>
                      )}
                      {agents.length === 0 && command.kind === "skill" && (
                        <span className="text-[10.5px] text-gray-400 dark:text-white/35">
                          {t("settings.graphify.noAgents")}
                        </span>
                      )}
                    </div>

                    {run && (
                      <pre
                        className={`max-h-48 overflow-auto cc-scroll whitespace-pre-wrap break-all
                          rounded-lg px-3 py-2 font-mono text-[10.5px] leading-relaxed
                          ${run.ok
                            ? "bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-300"
                            : "bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300"}`}
                        ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}
                      >
                        {run.output || " "}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
