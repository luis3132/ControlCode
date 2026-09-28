/**
 * El mensaje con que se le pasa un issue o un PR a un agente para que lo trabaje.
 *
 * Va en inglés, como todo lo que lee el modelo. Lleva el issue entero —descripción e hilo—
 * y no solo el enlace: el agente puede no tener cómo abrirlo (un repo privado, sin las
 * herramientas de git de Control Code), y con el texto adelante no gasta un paso en ir a
 * buscarlo.
 */
import type { ForgeItemDetail } from "./types";

/** Más que esto de hilo ya no es contexto, es ruido: un issue con 80 comentarios. */
const MAX_THREAD = 24_000;
const MAX_COMMENT = 4_000;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[… truncated]`;
}

export function itemPrompt(item: ForgeItemDetail, pr: boolean): string {
  const kind = pr ? "pull request" : "issue";
  const lines: string[] = [];

  lines.push(
    pr
      ? `Continue work on pull request #${item.number} of this repository and get it ready to merge.`
      : `Resolve issue #${item.number} of this repository.`,
    "",
    `Title: ${item.title}`,
    `URL: ${item.webUrl}`,
    `State: ${item.state}${item.draft ? " (draft)" : ""}`,
  );
  if (item.author) lines.push(`Author: @${item.author}`);
  if (item.labels.length) lines.push(`Labels: ${item.labels.join(", ")}`);
  if (pr && item.sourceBranch && item.targetBranch) {
    lines.push(`Branches: ${item.sourceBranch} → ${item.targetBranch}`);
  }

  lines.push("", `## Description`, "", item.body?.trim() ? clip(item.body.trim(), MAX_THREAD) : "(no description)");

  if (item.thread.length) {
    lines.push("", `## Comments`);
    let used = 0;
    let shown = 0;
    for (const c of item.thread) {
      const body = clip(c.body.trim(), MAX_COMMENT);
      if (used + body.length > MAX_THREAD) break;
      used += body.length;
      shown++;
      lines.push("", `### @${c.author ?? "unknown"}${c.createdAt ? ` (${c.createdAt})` : ""}`, "", body);
    }
    if (shown < item.thread.length) {
      lines.push("", `[${item.thread.length - shown} more comments omitted: read them at the URL above]`);
    }
  }

  lines.push(
    "",
    `## What to do`,
    "",
    ...(pr
      ? [
        `- Make sure you are on the \`${item.sourceBranch ?? "PR"}\` branch before changing anything.`,
        "- Read the PR's diff and the review comments above, and address whatever is still pending.",
      ]
      : [
        "- Read the relevant code first, and ask me if the issue is ambiguous before making large changes.",
        "- Implement the fix or feature, with tests where the project has them.",
      ]),
    `- If you have Control Code's git tools (git_${pr ? "pr" : "issue"}_view${pr ? ", git_pr_files, git_checks" : ""}), use them to read the latest state of this ${kind}.`,
    "- Don't push, comment or open pull requests unless I ask you to.",
  );

  return lines.join("\n");
}
