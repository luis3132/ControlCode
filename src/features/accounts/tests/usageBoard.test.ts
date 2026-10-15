import { describe, expect, it } from "vitest";

import { accountProblemKey, accountProblemText, needsLogin } from "../problem";
import { usageColor } from "../Ring";
import { untilText, windowLabel } from "../UsageBoard";

const t = (key: string, o?: Record<string, unknown>) => (o ? `${key}:${JSON.stringify(o)}` : key);

describe("problemas del cupo", () => {
  it("las claves del backend pasan tal cual", () => {
    expect(accountProblemKey("accounts.plan.problem.timeout")).toBe("accounts.plan.problem.timeout");
    expect(accountProblemKey("accounts.auth.expired")).toBe("accounts.auth.expired");
  });

  it("una sesión vencida se reconoce aunque venga cruda", () => {
    expect(accountProblemKey("OAuth token has expired")).toBe("accounts.auth.expired");
    expect(needsLogin("Not logged in · Please run /login")).toBe(true);
    expect(needsLogin("accounts.plan.problem.timeout")).toBe(false);
  });

  it("lo que no se reconoce se muestra tal cual", () => {
    expect(accountProblemText("spawn ENOENT", t)).toBe("spawn ENOENT");
    expect(accountProblemText(null, t)).toBe("accounts.plan.failed");
  });
});

describe("ventanas de Codex", () => {
  const w = (windowMins: number | null) => ({ utilization: 0, resetsAt: null, windowMins });

  it("se nombran por lo que duran", () => {
    expect(windowLabel(w(300), "week", t)).toBe("accounts.plan.session");
    expect(windowLabel(w(10080), "session", t)).toBe("accounts.plan.week");
    // El plan gratis: una sola ventana, de un mes. No es «semanal».
    expect(windowLabel(w(43200), "week", t)).toBe("accounts.usage.month");
    expect(windowLabel(w(2880), "week", t)).toBe('accounts.usage.windowDays:{"count":2}');
  });

  it("sin duración, la que diga el lugar", () => {
    expect(windowLabel(w(null), "week", t)).toBe("accounts.plan.week");
  });
});

describe("cuándo se reinicia", () => {
  it("en minutos, horas o días", () => {
    expect(untilText(null, 0, t)).toBeNull();
    expect(untilText(100, 200, t)).toBe("accounts.usage.resetsNow");
    expect(untilText(20 * 60, 0, t)).toBe('accounts.usage.resetsIn:{"value":"20 min"}');
    expect(untilText(80 * 60, 0, t)).toBe('accounts.usage.resetsIn:{"value":"1 h 20 min"}');
    expect(untilText(22 * 86400, 0, t)).toContain("accounts.usage.days");
  });
});

describe("color del uso", () => {
  it("sube a ámbar y a rojo con el uso", () => {
    expect(usageColor(10, "claude-code")).toBe("#f08a5d");
    expect(usageColor(75, "codex")).toBe("#f59e0b");
    expect(usageColor(95, "codex")).toBe("#ef4444");
  });
});
