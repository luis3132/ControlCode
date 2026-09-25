/** Lo que devuelve el backend de control de versiones. Ver `src-tauri/src/scm`. */

export interface ScmEntry {
  /** Relativa al root del repo, con `/`. */
  path: string;
  origPath: string | null;
  /** M, A, D, R, C, T, U o ?. */
  status: string;
}

export type Provider = "github" | "gitlab" | "bitbucket" | "azure" | "codeberg" | "other";

export interface Remote {
  name: string;
  url: string;
  provider: Provider;
  host: string | null;
  webUrl: string | null;
}

export interface ScmStatus {
  root: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  initial: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: ScmEntry[];
  unstaged: ScmEntry[];
  untracked: ScmEntry[];
  conflicted: ScmEntry[];
  truncated: boolean;
  remotes: Remote[];
  operation: "merge" | "rebase" | "cherryPick" | "revert" | null;
}

export interface Branch {
  name: string;
  remote: boolean;
  current: boolean;
  upstream: string | null;
  updatedAt: number;
}

export type RefKind = "head" | "local" | "remote" | "tag";

export interface CommitRef {
  name: string;
  kind: RefKind;
}

export interface Commit {
  hash: string;
  short: string;
  /** El primero es la rama en la que se estaba; los demás, lo que se fusionó. */
  parents: string[];
  author: string;
  time: number;
  subject: string;
  refs: CommitRef[];
  /** Está en el remoto y no en la rama local: lo que traería un pull. */
  incoming: boolean;
  /** Está en la rama local y no en el remoto: lo que falta subir. */
  outgoing: boolean;
}

/** `auth` = a git le faltan credenciales para el remoto. */
export interface ScmError {
  kind: "auth" | "git";
  message: string;
}

export function isScmError(e: unknown): e is ScmError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}
