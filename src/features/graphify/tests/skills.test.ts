import { describe, expect, it } from "vitest";

import type { GraphifyStatus, GraphifyTarget } from "../ipc";
import { orderedTargets, skillState, targetKey } from "../skills";

const target = (over: Partial<GraphifyTarget> = {}): GraphifyTarget => ({
  platform: null, agentId: "claude-code", label: "Claude Code",
  path: "/home/u/.claude/skills/graphify", installedVersion: null, sharedWithApp: false, ...over,
});

const cli = (version: string | null): GraphifyStatus => ({ installed: version !== null, version });

/// La skill viaja adentro del paquete: actualizar el paquete NO actualiza la copia en
/// disco. Graphify lo avisa a mitad de una sesión del agente; acá se puede decir antes.
describe("en qué estado quedó la skill de cada destino", () => {
  it("compara el sello de la skill con la versión del CLI", () => {
    expect(skillState(target(), cli("8.3.1"))).toBe("missing");
    expect(skillState(target({ installedVersion: "8.3.1" }), cli("8.3.1"))).toBe("current");
    expect(skillState(target({ installedVersion: "8.2.0" }), cli("8.3.1"))).toBe("stale");
  });

  /// Sin CLI no hay con qué comparar. Decir "al día" ahí sería afirmar algo que no se
  /// comprobó, y justo es el caso en que la skill suele estar vieja.
  it("sin CLI dice que está instalada, no que está al día", () => {
    expect(skillState(target({ installedVersion: "8.2.0" }), cli(null))).toBe("unknown");
    expect(skillState(target({ installedVersion: "8.2.0" }), null)).toBe("unknown");
    expect(skillState(target(), null)).toBe("missing");
  });
});

describe("la lista de destinos", () => {
  /// Son seis y casi siempre interesa uno: donde ya hay algo. Reinstalar después de
  /// actualizar el paquete es el caso repetido, y no tiene que obligar a buscar cuál era.
  it("pone primero los que ya tienen la skill, sin perder ninguno", () => {
    const list = [
      target({ platform: "opencode", installedVersion: null }),
      target({ platform: "agents", installedVersion: "8.3.1" }),
      target({ platform: null, installedVersion: null }),
      target({ platform: "codex", installedVersion: "8.2.0" }),
    ];
    const ordered = orderedTargets(list);
    expect(ordered.map((x) => x.platform)).toEqual(["agents", "codex", "opencode", null]);
    expect(list.map((x) => x.platform)).toEqual(["opencode", "agents", null, "codex"]);
  });

  /// La plataforma por defecto no tiene nombre en `--platform`, así que su clave es "".
  it("cada destino se identifica por su plataforma", () => {
    expect(targetKey(target({ platform: "opencode" }))).toBe("opencode");
    expect(targetKey(target({ platform: null }))).toBe("");
  });
});
