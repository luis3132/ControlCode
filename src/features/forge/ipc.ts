/**
 * Comandos de cuentas de git. Ver `src-tauri/src/forge/commands.rs`.
 *
 * El único archivo de esta feature que habla con Tauri (ver `accounts/ipc.ts`).
 */
import { invoke } from "@tauri-apps/api/core";

import type {
  DevicePoll, DeviceStart, ForgeItem, ForgeItemDetail, ForgeKind, ForgeKindInfo, ForgeRepo, GitAccount, Label, NewIssue, NewPull, NewRelease, Release, RepoOwner, RepoTarget,
} from "./types";

export const forgeKinds = () => invoke<ForgeKindInfo[]>("forge_kinds");
export const forgeOauthAvailable = (kind: ForgeKind, host: string) =>
  invoke<boolean>("forge_oauth_available", { kind, host });
export const forgeAccounts = () => invoke<GitAccount[]>("forge_accounts");
export const forgeDeviceStart = (kind: ForgeKind, host: string) =>
  invoke<DeviceStart>("forge_device_start", { kind, host });
export const forgeDevicePoll = (flowId: string) => invoke<DevicePoll>("forge_device_poll", { flowId });
export const forgeDeviceCancel = (flowId: string) => invoke<void>("forge_device_cancel", { flowId });
export const forgeAddToken = (kind: ForgeKind, host: string, token: string, username: string | null) =>
  invoke<GitAccount>("forge_add_token", { kind, host, token, username });
export const forgeRemoveAccount = (id: string) => invoke<void>("forge_remove_account", { id });

export const forgeRepos = (accountId: string) => invoke<ForgeRepo[]>("forge_repos", { accountId });
/** Dónde puede crear repos la cuenta: ella misma primero, después sus organizaciones. */
export const forgeOwners = (accountId: string) => invoke<RepoOwner[]>("forge_owners", { accountId });
/** Crea el repo en el host para la carpeta `cwd` (inicializándola si no es un repo), lo
 *  deja como `origin` y sube la rama. */
export const forgeCreateRepo = (args: {
  cwd: string; accountId: string; owner: RepoOwner | null; name: string; description: string | null; private: boolean;
}) => invoke<ForgeRepo>("forge_create_repo", args);
/** Devuelve la carpeta del clon. */
export const forgeClone = (url: string, parent: string, name: string | null, accountId: string | null) =>
  invoke<string>("forge_clone", { url, parent, name, accountId });

/** `null` = sin repo o sin remoto. */
export const forgeRepo = (cwd: string) => invoke<RepoTarget | null>("forge_repo", { cwd });
export const forgeSetRepoAccount = (root: string, accountId: string) =>
  invoke<void>("forge_set_repo_account", { root, accountId });

export const forgePulls = (cwd: string, state: string) => invoke<ForgeItem[]>("forge_pulls", { cwd, state });
export const forgeIssues = (cwd: string, state: string) => invoke<ForgeItem[]>("forge_issues", { cwd, state });
export const forgeItem = (cwd: string, number: number, pr: boolean) =>
  invoke<ForgeItemDetail>("forge_item", { cwd, number, pr });
export const forgeCreatePull = (cwd: string, pull: NewPull) => invoke<ForgeItem>("forge_create_pull", { cwd, pull });
export const forgeCreateIssue = (cwd: string, issue: NewIssue) =>
  invoke<ForgeItem>("forge_create_issue", { cwd, issue });
export const forgeComment = (cwd: string, number: number, pr: boolean, body: string) =>
  invoke<void>("forge_comment", { cwd, number, pr, body });
export const forgeMergePull = (cwd: string, number: number, method: "merge" | "squash" | "rebase") =>
  invoke<void>("forge_merge_pull", { cwd, number, method });
export const forgeDefaultBranch = (cwd: string) => invoke<string | null>("forge_default_branch", { cwd });
/** Devuelve el nombre de la rama local (`pr/<n>`). */
export const forgeCheckoutPull = (cwd: string, number: number) =>
  invoke<string>("forge_checkout_pull", { cwd, number });

/** Las etiquetas del repo, para sugerirlas al abrir un issue. */
export const forgeLabels = (cwd: string) => invoke<Label[]>("forge_labels", { cwd });

export const forgeReleases = (cwd: string) => invoke<Release[]>("forge_releases", { cwd });
export const forgeCreateRelease = (cwd: string, release: NewRelease) =>
  invoke<Release>("forge_create_release", { cwd, release });

/** Las ya bajadas, por URL: volver a abrir el mismo issue no las pide de nuevo. Se guarda
 *  la promesa para que dos comentarios con la misma captura hagan un solo pedido. */
const imageCache = new Map<string, Promise<string>>();

/**
 * Dónde está de verdad una imagen de un PR o issue cuya página es `pageUrl`.
 *
 * GitLab escribe los adjuntos relativos al proyecto (`/uploads/…`), y la página es
 * `https://host/grupo/repo/-/issues/3`: el proyecto es lo de antes de `/-/`. Todo lo demás
 * relativo cuelga del host, que es como lo resolvería el navegador.
 */
export function resolveForgeImage(src: string, pageUrl: string): string {
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith("/uploads/") && pageUrl.includes("/-/")) return pageUrl.split("/-/")[0] + src;
  try {
    return new URL(src, pageUrl).toString();
  } catch {
    return src;
  }
}

export function forgeImage(cwd: string, url: string): Promise<string> {
  const key = `${cwd}\n${url}`;
  let p = imageCache.get(key);
  if (!p) {
    p = invoke<string>("forge_image", { cwd, url });
    // Un fallo no se recuerda: puede ser la red, y reabrir tiene que volver a intentar.
    p.catch(() => imageCache.delete(key));
    imageCache.set(key, p);
  }
  return p;
}
