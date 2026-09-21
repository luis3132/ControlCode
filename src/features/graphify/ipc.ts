/** El instalador de graphify. Ver `src-tauri/src/graphify/`. */
import { invoke } from "@tauri-apps/api/core";

/** Un paso del instalador, con el comando tal como quedó editado. */
export interface GraphifyStep {
  id: string;
  command: string;
}

/** El alcance del instalador de graphify: el perfil del usuario o este proyecto. */
export type GraphifyScope = "global" | "project";

/**
 * Dónde cae la skill con una plataforma y un alcance.
 *
 * Graphify elige la carpeta por plataforma (`.opencode/skills`, `.codex/skills`…) y no por
 * el estándar abierto, así que el destino no se puede deducir del agente: lo dice el
 * backend, que tiene la tabla de graphify.
 */
export interface GraphifyTarget {
  /** El valor de `--platform`. `null` = la de por defecto, sin flag. */
  platform: string | null;
  /** La TUI a la que le sirve. `null` = a todas las que leen `.agents/skills`. */
  agentId: string | null;
  label: string;
  path: string;
  /** La versión con la que se escribió la skill que hay ahí. `null` = no hay ninguna, o
   *  la hay pero sin sello. */
  installedVersion: string | null;
  /** Si es una carpeta donde Control Code también monta skills del proyecto. */
  sharedWithApp: boolean;
}

export interface GraphifyPlan {
  steps: GraphifyStep[];
  defaults: GraphifyStep[];
  cliAlternatives: string[];
  targets: GraphifyTarget[];
  /** Los extras de PyPI: cada uno agrega un formato o un backend al paquete. */
  extras: string[];
  backends: string[];
}

/** Un requisito previo (Python, uv, pipx) con lo que se encontró en esta máquina. */
export interface GraphifyRequirement {
  id: string;
  command: string;
  docsUrl: string;
  /** Lo que contestó `--version`. `null` = no está en el PATH. */
  version: string | null;
  /** El comando de instalación de ESTE sistema. `null` = en este sistema se baja a mano. */
  install: string | null;
  otherInstalls: string[];
}

/** Un hueco de un comando. `options` vacío = texto libre. */
export interface GraphifyArg {
  name: string;
  default: string;
  options: string[];
}

export interface GraphifyFlag {
  id: string;
  text: string;
}

/**
 * Un comando del catálogo.
 *
 * `kind` decide a dónde va: `shell` corre en la terminal del sistema, `skill` es una línea
 * que se escribe ADENTRO del asistente (`/graphify .`) y por eso se manda a una tab de
 * agente — en un shell daría "command not found".
 */
export interface GraphifyCommand {
  id: string;
  group: string;
  kind: "shell" | "skill";
  template: string;
  args: GraphifyArg[];
  flags: GraphifyFlag[];
  /** No termina solo (`watch`, el servidor MCP): solo tiene sentido en una terminal. */
  longRunning: boolean;
}

/** Lo elegido en una fila del catálogo. */
export interface GraphifyChoice {
  flags: string[];
  args: Record<string, string>;
}

export interface GraphifyStatus {
  installed: boolean;
  version: string | null;
}

export interface GraphifyRun {
  ok: boolean;
  code: number | null;
  output: string;
}

export const graphifyPlan = (cwd: string, scope: GraphifyScope) =>
  invoke<GraphifyPlan>("graphify_plan", { cwd, scope });

export const graphifySaveSteps = (steps: GraphifyStep[]) =>
  invoke<GraphifyStep[]>("graphify_save_steps", { steps });

/** El comando del paso 2 para un destino. Lo arma el backend: los flags son de graphify. */
export const graphifyInstallCommand = (platform: string | null, scope: GraphifyScope) =>
  invoke<string>("graphify_install_command", { platform, scope });

export const graphifyStatus = () => invoke<GraphifyStatus>("graphify_status");

export const graphifyRunStep = (command: string, cwd: string) =>
  invoke<GraphifyRun>("graphify_run_step", { command, cwd });

export const graphifyRequirements = () => invoke<GraphifyRequirement[]>("graphify_requirements");

export const graphifyCommands = () => invoke<GraphifyCommand[]>("graphify_commands");

/** El comando final de una fila. Lo arma el backend: lo que se ve es lo que se ejecuta. */
export const graphifyRender = (id: string, choice: GraphifyChoice) =>
  invoke<string>("graphify_render", { id, choice });

/** El paso 1 con los extras elegidos: `uv tool install "graphifyy[pdf,video]"`. */
export const graphifyPackageCommand = (base: string, extras: string[]) =>
  invoke<string>("graphify_package_command", { base, extras });
