/** Control de versiones. Ver `src-tauri/src/scm/commands.rs`. */
import { invoke } from "@tauri-apps/api/core";

import type { Branch, Commit, ScmEntry, ScmStatus, Tag } from "./types";

/** `null` = la carpeta no está en un repo. */
export const scmStatus = (cwd: string) => invoke<ScmStatus | null>("scm_status", { cwd });
export const scmInit = (cwd: string) => invoke<void>("scm_init", { cwd });
/** Sin rutas = todo. */
export const scmStage = (root: string, paths: string[]) => invoke<void>("scm_stage", { root, paths });
export const scmUnstage = (root: string, paths: string[]) => invoke<void>("scm_unstage", { root, paths });
export const scmDiscard = (root: string, tracked: string[], untracked: string[]) =>
  invoke<void>("scm_discard", { root, tracked, untracked });
export const scmCommit = (root: string, message: string, stageAll: boolean) =>
  invoke<void>("scm_commit", { root, message, stageAll });
export const scmBranches = (root: string) => invoke<Branch[]>("scm_branches", { root });
export const scmCheckout = (root: string, name: string, create: boolean, remote: boolean) =>
  invoke<void>("scm_checkout", { root, name, create, remote });
export const scmFetch = (root: string) => invoke<void>("scm_fetch", { root });
export const scmPull = (root: string) => invoke<void>("scm_pull", { root });
export const scmPush = (root: string) => invoke<void>("scm_push", { root });
export const scmLog = (root: string, limit: number) => invoke<Commit[]>("scm_log", { root, limit });
/** Contenido en una revisión: `HEAD`, `INDEX`, un commit o su padre (`abc123^`); `null`
 *  si no existe ahí. */
export const scmFileAt = (root: string, path: string, rev: string) =>
  invoke<string | null>("scm_file_at", { root, path, rev });
/** Los archivos que cambió un commit, contra su primer padre. */
export const scmCommitFiles = (root: string, hash: string) =>
  invoke<ScmEntry[]>("scm_commit_files", { root, hash });

export const scmTags = (root: string) => invoke<Tag[]>("scm_tags", { root });
/** Sin `target`, en HEAD. Con `message`, anotado. */
export const scmCreateTag = (root: string, name: string, target: string | null, message: string | null) =>
  invoke<void>("scm_create_tag", { root, name, target, message });
/** Sube el tag al remoto con la cuenta de git de la app. */
export const scmPushTag = (root: string, name: string) => invoke<void>("scm_push_tag", { root, name });
/** Borra el tag LOCAL; el del remoto no se toca. */
export const scmDeleteTag = (root: string, name: string) => invoke<void>("scm_delete_tag", { root, name });
