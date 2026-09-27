import { describe, expect, it } from "vitest";

import { newApprovalIds } from "../ApprovalToast";
import type { PendingApproval } from "../types";

const approval = (id: string): PendingApproval =>
  ({ id, taskId: "t", toolName: "Bash", input: {}, askedAt: 0, suggestedRule: null });

describe("los pedidos de permiso nuevos", () => {
  it("son los que no estaban en la lista anterior", () => {
    expect(newApprovalIds(new Set(), [approval("a"), approval("b")])).toEqual(["a", "b"]);
    expect(newApprovalIds(new Set(["a"]), [approval("a"), approval("c")])).toEqual(["c"]);
  });

  it("que se conteste uno no es un pedido nuevo", () => {
    expect(newApprovalIds(new Set(["a", "b"]), [approval("b")])).toEqual([]);
  });
});
