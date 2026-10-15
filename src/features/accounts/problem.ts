/**
 * Por qué no se pudo leer el cupo de una cuenta, en el idioma de la interfaz.
 *
 * El backend manda claves de i18n (`accounts.plan.problem.*`, `accounts.auth.*`). Lo que
 * no es una clave es un error crudo de la TUI o del sistema: se reconoce lo que se pueda
 * (una sesión vencida se dice así, con el botón de volver a loguearse) y el resto se
 * muestra tal cual, que es mejor que esconderlo.
 */
const KEY = /^accounts\.(plan\.problem|auth)\.[A-Za-z]+$/;

export function accountProblemKey(problem: string | null): string | null {
  if (!problem) return null;
  if (KEY.test(problem)) return problem;
  if (/OAuth session expired|OAuth token (?:has )?expired/i.test(problem)) return "accounts.auth.expired";
  if (/not logged in|please run \/login/i.test(problem)) return "accounts.auth.required";
  if (problem.startsWith("No se pudo leer ")) return "accounts.plan.problem.configRead";
  if (/^No se pudo (?:crear|escribir|actualizar) |^No se pudieron ajustar los permisos de /.test(problem)) {
    return "accounts.plan.problem.configWrite";
  }
  return null;
}

export function accountProblemText(problem: string | null, t: (key: string) => string): string {
  const key = accountProblemKey(problem);
  return key ? t(key) : problem || t("accounts.plan.failed");
}

/** La sesión venció o nunca se inició: lo que lo arregla es volver a loguearse. */
export const needsLogin = (problem: string | null) => {
  const key = accountProblemKey(problem);
  return key === "accounts.auth.expired" || key === "accounts.auth.required";
};
