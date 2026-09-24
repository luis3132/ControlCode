import { CloudIcon } from "neogestify-ui-components";

import { BranchIcon, GithubIcon, GitlabIcon } from "@/app/icons";

import type { ForgeKind } from "./types";

export const FORGE_KINDS: ForgeKind[] = ["github", "gitlab", "gitea", "other"];

/** Nombres propios: no se traducen. El genérico sí (ver `forge.kind.other`). */
const LABELS: Record<Exclude<ForgeKind, "other">, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea / Forgejo",
};

export function forgeLabel(kind: ForgeKind, t: (key: string) => string): string {
  return kind === "other" ? t("forge.kind.other") : LABELS[kind];
}

export function ForgeIcon({ kind, className }: { kind: ForgeKind | null; className: string }) {
  if (kind === "github") return <GithubIcon className={className} />;
  if (kind === "gitlab") return <GitlabIcon className={className} />;
  if (kind === "gitea") return <BranchIcon className={className} />;
  return <CloudIcon className={className} />;
}

/**
 * Dónde se crea un token en cada host, con los permisos ya marcados cuando el host deja
 * pasarlos por la URL. Son los mismos que pide el inicio de sesión con navegador.
 */
export function tokenPageUrl(kind: ForgeKind, host: string): string | null {
  switch (kind) {
    case "github":
      return host === "github.com"
        ? "https://github.com/settings/tokens/new?scopes=repo,read:org,workflow&description=ControlCode"
        : `https://${host}/settings/tokens/new?scopes=repo,read:org,workflow&description=ControlCode`;
    case "gitlab":
      return `https://${host}/-/user_settings/personal_access_tokens?name=ControlCode&scopes=api,read_user,write_repository`;
    case "gitea":
      return `https://${host}/user/settings/applications`;
    default:
      return null;
  }
}

/** Los permisos a marcar a mano, para los hosts que no los toman de la URL. */
export const TOKEN_SCOPES: Record<ForgeKind, string> = {
  github: "repo, read:org, workflow",
  gitlab: "api, read_user, write_repository",
  gitea: "repository (read/write), issue (read/write), user (read)",
  other: "",
};
