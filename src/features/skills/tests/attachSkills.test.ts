import { beforeEach, describe, expect, it, vi } from "vitest";

import { attachSkillsToTab } from "../attachSkills";
import * as ipc from "../ipc";

vi.mock("@/features/tabs/persistence", () => ({ flushPendingSave: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../ipc", () => ({
  attachSkill: vi.fn(),
  syncWorkspaceSkills: vi.fn(),
}));

const attachSkill = vi.mocked(ipc.attachSkill);
const syncWorkspaceSkills = vi.mocked(ipc.syncWorkspaceSkills);

beforeEach(() => {
  attachSkill.mockReset().mockResolvedValue(undefined);
  syncWorkspaceSkills.mockReset().mockResolvedValue(undefined);
});

describe("attachSkillsToTab", () => {
  it("monta todas las skills con scope de tab", async () => {
    const errors = await attachSkillsToTab("tab-1", "ws-1", ["a", "b"]);

    expect(errors).toEqual([]);
    expect(attachSkill).toHaveBeenCalledTimes(2);
    expect(attachSkill).toHaveBeenNthCalledWith(1, "a", "ws-1", "tab", "tab-1");
    expect(attachSkill).toHaveBeenNthCalledWith(2, "b", "ws-1", "tab", "tab-1");
  });

  /// El bug que motivó esta función: que una skill falle no puede dejar la tab sin el
  /// resto, pero perder el error tampoco — el síntoma era "se abrió sin ninguna skill" y
  /// lo único que quedaba era una línea en la consola del webview, que nadie ve.
  it("sigue con las demás cuando una falla, y devuelve lo que falló", async () => {
    attachSkill
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("no existe"))
      .mockResolvedValueOnce(undefined);

    const errors = await attachSkillsToTab("tab-1", "ws-1", ["a", "rota", "c"]);

    expect(attachSkill).toHaveBeenCalledTimes(3);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("no existe");
  });

  /// La sincronización del workspace es best-effort y aparte: solo hace que la tab herede
  /// las skills que el workspace ya tenía, y que falle no es parte de lo que se pidió.
  it("un fallo al sincronizar el workspace no se reporta como error de montaje", async () => {
    syncWorkspaceSkills.mockRejectedValue(new Error("qué sé yo"));

    await expect(attachSkillsToTab("tab-1", "ws-1", ["a"])).resolves.toEqual([]);
    expect(syncWorkspaceSkills).toHaveBeenCalledWith("ws-1");
  });

  it("sin skills que montar igual sincroniza el workspace", async () => {
    const errors = await attachSkillsToTab("tab-1", "ws-1", []);

    expect(errors).toEqual([]);
    expect(attachSkill).not.toHaveBeenCalled();
    expect(syncWorkspaceSkills).toHaveBeenCalledOnce();
  });
});
