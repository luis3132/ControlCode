/** Cuentas de hosting git y lo que se hace con ellas. Ver `src-tauri/src/forge`. */

export type ForgeKind = "github" | "gitlab" | "gitea" | "other";

export interface ForgeKindInfo {
  kind: ForgeKind;
  defaultHost: string | null;
  /** Si el host por defecto tiene inicio de sesión con navegador. */
  oauth: boolean;
  /** Si tiene API (PRs, issues, repos). Un host genérico solo tiene credenciales. */
  api: boolean;
}

export interface GitAccount {
  id: string;
  kind: ForgeKind;
  host: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  /** `oauth` (navegador) o `token` (pegado a mano). */
  auth: "oauth" | "token";
  gitUser: string | null;
  createdAt: number;
  /** `file` = no había llavero del sistema y el token quedó en un archivo 0600. */
  storage: "keyring" | "file" | null;
}

export interface DeviceStart {
  flowId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresIn: number;
  interval: number;
}

export type DevicePoll =
  | { status: "pending"; interval: number }
  | { status: "done"; account: GitAccount }
  | { status: "expired" }
  | { status: "denied" };

export interface ForgeRepo {
  fullName: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  archived: boolean;
  cloneUrl: string;
  sshUrl: string | null;
  webUrl: string;
  defaultBranch: string | null;
  updatedAt: string | null;
}

/** Qué repo es el del workspace y con qué cuenta se trabaja en él. */
export interface RepoTarget {
  root: string;
  remote: string;
  remoteUrl: string;
  host: string;
  path: string;
  kind: ForgeKind | null;
  account: GitAccount | null;
  accounts: GitAccount[];
  ssh: boolean;
}

export type ItemState = "open" | "closed" | "merged";

/** Un PR (merge request en GitLab) o un issue. */
export interface ForgeItem {
  number: number;
  title: string;
  state: ItemState;
  draft: boolean;
  author: string | null;
  webUrl: string;
  createdAt: string | null;
  updatedAt: string | null;
  comments: number | null;
  labels: string[];
  sourceBranch: string | null;
  targetBranch: string | null;
}

export interface ForgeComment {
  author: string | null;
  body: string;
  createdAt: string | null;
}

export interface ForgeItemDetail extends ForgeItem {
  body: string | null;
  thread: ForgeComment[];
}

export interface NewPull {
  title: string;
  body?: string;
  head: string;
  base: string;
  draft: boolean;
}

export interface NewIssue {
  title: string;
  body?: string;
  labels: string[];
}

/**
 * - `noAccount`: no hay cuenta para ese host (el mensaje ES el host).
 * - `auth`: el host rechazó el token; hay que volver a iniciar sesión.
 * - `unsupported`: cuenta genérica sin API, o repo sin remoto.
 */
export interface ForgeError {
  kind: "noAccount" | "auth" | "unsupported" | "api";
  message: string;
}

export function isForgeError(e: unknown): e is ForgeError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

export function forgeErrorOf(e: unknown): ForgeError {
  return isForgeError(e) ? e : { kind: "api", message: String(e) };
}
