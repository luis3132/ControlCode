import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimateSpin, Button, CheckCircleIcon, CopyIcon, Input } from "neogestify-ui-components";
import { openUrl } from "@tauri-apps/plugin-opener";
import { homeDir } from "@tauri-apps/api/path";

import { runInTerminal } from "@/features/graphify/send";
import { SettingsSection } from "@/features/settings/SettingsSection";

import {
  skillsshCheckStep, skillsshNodeInstall, type NodeInstall, type SkillsShStep, type SkillsShStepResult,
} from "./ipc";

/** En este orden: cada uno supone el anterior (sin `npx` no hay CLI que probar). */
const STEPS: SkillsShStep[] = ["node", "npx", "cli", "search"];

/**
 * Si esta máquina puede usar skills.sh, paso por paso.
 *
 * Existe porque en otra distro o sistema el marketplace solo decía "no anda": skills.sh se
 * consulta con su CLI (`npx skills`), que pide Node 22.20 o más, y lo que falla cambia de
 * máquina en máquina — no hay Node, es el 18 de los repositorios de Ubuntu, falta `npx`
 * (en Debian viene aparte), la app no lo encuentra en su PATH, o no hay red hasta npm o
 * skills.sh. Acá se prueba cada cosa por separado y se muestra lo que contestó.
 *
 * Validar vuelve a leer el PATH del shell (ver `marketplace/skillssh_check.rs`): instalar
 * Node desde la terminal que se abre acá y validar de nuevo alcanza, sin reiniciar la app.
 */
export function SkillsShSection() {
  const { t } = useTranslation();
  const [results, setResults] = useState<Partial<Record<SkillsShStep, SkillsShStepResult>>>({});
  const [running, setRunning] = useState<SkillsShStep | null>(null);
  const [validated, setValidated] = useState(false);
  const [install, setInstall] = useState<NodeInstall | null>(null);
  const [command, setCommand] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    skillsshNodeInstall()
      .then((found) => {
        setInstall(found);
        setCommand(found.install ?? "");
      })
      .catch(() => setInstall(null));
  }, []);

  const validate = async () => {
    setResults({});
    setNote("");
    setValidated(true);
    for (const step of STEPS) {
      setRunning(step);
      let result: SkillsShStepResult;
      try {
        result = await skillsshCheckStep(step);
      } catch (e) {
        result = { step, state: "fail", path: null, version: null, output: String(e), results: null };
      }
      setResults((prev) => ({ ...prev, [step]: result }));
      // Un Node viejo no corta: el paso de la CLI es el que dice si de verdad no le sirve.
      if (result.state === "fail") break;
    }
    setRunning(null);
  };

  const openTerminal = async () => {
    if (!command.trim()) return;
    const home = await homeDir().catch(() => ".");
    runInTerminal(command.trim(), home, "Node.js");
    setNote(t("settings.skillssh.sentToTerminal"));
  };

  const copy = () => {
    navigator.clipboard.writeText(command).then(() => setNote(t("settings.skillssh.copied"))).catch(console.error);
  };

  const needsNode = results.node !== undefined && results.node.state !== "ok"
    || results.npx?.state === "fail";
  const min = install?.minNode ?? "22.20.0";

  const detail = (step: SkillsShStep, result: SkillsShStepResult | undefined): string => {
    if (!result) {
      if (running === step) return step === "cli" ? t("settings.skillssh.firstTime") : t("settings.skillssh.running");
      return validated && running === null ? t("settings.skillssh.skipped") : t("settings.skillssh.notRun");
    }
    const where = result.path ? ` · ${result.path}` : "";
    if (step === "node" && result.state === "warn") {
      return `${t("settings.skillssh.nodeOld", { version: result.version ?? "?", min })}${where}`;
    }
    if (result.state === "fail" && !result.path && (step === "node" || step === "npx")) {
      return step === "npx" ? t("settings.skillssh.npxMissing") : t("settings.skillssh.notFound", { command: step });
    }
    if (result.state === "fail") return result.path ?? "";
    if (step === "search") {
      return result.state === "ok"
        ? t("settings.skillssh.searchOk", { count: result.results ?? 0 })
        : t("settings.skillssh.searchEmpty");
    }
    if (step === "cli") return t("settings.skillssh.cliOk", { version: result.version ?? "" });
    return `${result.version ?? ""}${where}`;
  };

  return (
    <SettingsSection
      title={t("settings.skillssh")}
      description={t("settings.skillssh.desc", { min })}
      action={(
        <Button
          variant="outline"
          size="sm"
          onClick={validate}
          disabled={running !== null}
          leftIcon={running ? <AnimateSpin className="w-3.5 h-3.5" /> : undefined}
        >
          {t("settings.skillssh.validate")}
        </Button>
      )}
    >
      <div className="flex flex-col gap-1">
        {STEPS.map((step) => {
          const result = results[step];
          return (
            <div key={step} className="flex flex-col gap-1.5 px-3 py-1.5 rounded-lg bg-gray-100/70 dark:bg-white/4">
              <div className="flex items-center gap-2.5 min-w-0">
                <StateMark state={result?.state} busy={running === step} />
                <span className="w-40 shrink-0 truncate text-[12px] text-gray-800 dark:text-gray-100">
                  {t(`settings.skillssh.step.${step}`)}
                </span>
                <span
                  className={`flex-1 min-w-0 truncate text-[10.5px]
                    ${result?.state === "fail" || result?.state === "warn"
                      ? "text-amber-700 dark:text-amber-300"
                      : "text-gray-400 dark:text-white/35"}
                    ${result?.path || result?.version ? "font-mono" : ""}`}
                  title={detail(step, result)}
                >
                  {detail(step, result)}
                </span>
              </div>
              {result?.output && (
                <pre className="max-h-40 overflow-auto cc-scroll whitespace-pre-wrap break-all rounded-md px-2.5 py-1.5
                  font-mono text-[10.5px] leading-relaxed bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300">
                  {result.output}
                </pre>
              )}
            </div>
          );
        })}
      </div>

      {/* Solo cuando Node es lo que falta: sin eso, un comando de instalación a la vista es
          ruido para quien ya tiene todo andando. */}
      {needsNode && install && (
        <div className="flex flex-col gap-2 px-3 py-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5">
          <span className="text-[11.5px] font-semibold text-gray-800 dark:text-gray-100">
            {t("settings.skillssh.fixTitle", { min })}
          </span>
          <div className="flex items-center gap-2">
            <Input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              variant="minimal"
              size="sm"
              className="flex-1 !font-mono !text-[11px]"
              spellCheck={false}
            />
            <Button variant="outline" size="sm" onClick={() => void openTerminal()} disabled={!command.trim()}>
              {t("settings.skillssh.openTerminal")}
            </Button>
            <Button variant="ghost" size="sm" onClick={copy} disabled={!command.trim()} aria-label={t("settings.skillssh.copy")}>
              <CopyIcon className="w-3.5 h-3.5" />
            </Button>
          </div>
          {install.otherInstalls.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {install.otherInstalls.map((alt) => (
                <button
                  key={alt}
                  onClick={() => setCommand(alt)}
                  className="cc-t max-w-full truncate px-2 py-0.5 rounded font-mono text-[10px]
                    bg-gray-100 dark:bg-white/5 text-gray-500 dark:text-white/40
                    hover:bg-gray-200 dark:hover:bg-white/10"
                  title={alt}
                >
                  {alt}
                </button>
              ))}
            </div>
          )}
          <p className="text-[10.5px] leading-relaxed text-gray-500 dark:text-white/40">
            {t("settings.skillssh.afterInstall")}{" "}
            <button onClick={() => openUrl(install.docsUrl)} className="cc-t text-blue-600 dark:text-blue-400 hover:underline">
              {t("settings.skillssh.docs")}
            </button>
          </p>
        </div>
      )}

      {note && <p className="text-[11px] text-gray-500 dark:text-white/40">{note}</p>}
    </SettingsSection>
  );
}

function StateMark({ state, busy }: { state?: SkillsShStepResult["state"]; busy: boolean }) {
  if (busy) return <AnimateSpin className="w-3.5 h-3.5 shrink-0 text-gray-400" />;
  if (state === "ok") return <CheckCircleIcon className="w-3.5 h-3.5 shrink-0 text-emerald-500" />;
  const color = state === "fail" ? "bg-red-500" : state === "warn" ? "bg-amber-500" : "bg-gray-300 dark:bg-white/20";
  return <span className={`w-1.5 h-1.5 mx-1 rounded-full shrink-0 ${color}`} />;
}
