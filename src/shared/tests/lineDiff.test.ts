import { describe, expect, it } from "vitest";

import { diffLines, patchLines, withContext, type DiffLine } from "../lineDiff";

const signs = (lines: { sign: string }[]) => lines.map((l) => l.sign).join("");

describe("diffLines", () => {
  it("solo pinta lo que cambió: lo igual queda sin color (issue #23)", () => {
    const before = "uno\ndos\ntres\ncuatro\ncinco";
    const after = "uno\ndos\nTRES\ncuatro\ncinco";
    const lines = diffLines(before, after);
    expect(signs(lines)).toBe("  -+  ");
    expect(lines[2]).toEqual({ sign: "-", text: "tres", oldNo: 3 });
    expect(lines[3]).toEqual({ sign: "+", text: "TRES", newNo: 3 });
    expect(lines[4]).toEqual({ sign: " ", text: "cuatro", oldNo: 4, newNo: 4 });
  });

  it("una línea agregada o quitada en el medio no arrastra a las demás", () => {
    expect(signs(diffLines("a\nb\nc", "a\nb\nNUEVA\nc"))).toBe("  + ");
    expect(signs(diffLines("a\nb\nc\nd", "a\nc\nd"))).toBe(" -  ");
    // Cambios separados: cada uno en su lugar, lo del medio intacto.
    expect(signs(diffLines("a\nb\nc\nd\ne", "A\nb\nc\nd\nE"))).toBe("-+   -+");
  });

  it("un archivo nuevo es todo verde, y vaciarlo todo rojo", () => {
    expect(signs(diffLines("", "x\ny"))).toBe("++");
    expect(signs(diffLines("x\ny", ""))).toBe("--");
    expect(diffLines("", "")).toEqual([]);
  });

  it("numera desde la línea en que empieza el fragmento", () => {
    const lines = diffLines("a\nb", "a\nB", 40);
    expect(lines[0]).toEqual({ sign: " ", text: "a", oldNo: 40, newNo: 40 });
    expect(lines[2]).toEqual({ sign: "+", text: "B", newNo: 41 });
  });
});

describe("withContext", () => {
  it("deja los cambios con su contexto y resume lo demás", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l10", "X");
    const shown = withContext(diffLines(before, after), 2);
    expect(shown[0]).toEqual({ sign: "gap", count: 8 });
    expect(signs(shown.slice(1, 7) as DiffLine[])).toBe("  -+  ");
    expect(shown[7]).toEqual({ sign: "gap", count: 7 });
  });
});

describe("patchLines", () => {
  it("lee el diff de la CLI con sus números de línea", () => {
    const lines = patchLines([
      { oldStart: 7, newStart: 7, lines: [" igual", "-sale", "+entra", "\\ No newline at end of file"] },
      { oldStart: 30, newStart: 30, lines: ["+otra"] },
    ]);
    expect(lines).toEqual([
      { sign: " ", text: "igual", oldNo: 7, newNo: 7 },
      { sign: "-", text: "sale", oldNo: 8 },
      { sign: "+", text: "entra", newNo: 8 },
      { sign: "gap", count: 0 },
      { sign: "+", text: "otra", newNo: 30 },
    ]);
  });
});
