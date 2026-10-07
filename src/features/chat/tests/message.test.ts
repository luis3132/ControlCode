import { describe, expect, it } from "vitest";

import { buildContent, mention, modelLabel, parseSlash, slashAction, slashMenu, slashQuery } from "../message";

describe("buildContent", () => {
  it("las imágenes van primero y el texto vacío no se manda", () => {
    const img = { name: "a.png", mediaType: "image/png", data: "AAAA" };
    expect(buildContent({ text: "mirá", images: [img] })).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "mirá" },
    ]);
    expect(buildContent({ text: "  ", images: [img] })).toHaveLength(1);
  });
});

describe("comandos de /", () => {
  it("separa el nombre de los argumentos", () => {
    expect(parseSlash("/model sonnet")).toEqual({ name: "model", args: "sonnet" });
    expect(parseSlash("/anthropic-skills:pdf convertí esto\ny esto")).toEqual({
      name: "anthropic-skills:pdf", args: "convertí esto\ny esto",
    });
    expect(parseSlash("hola /model")).toBeNull();
  });

  it("decide qué es de la app, qué es solo de la consola y qué va al agente", () => {
    expect(slashAction("/clear", [])).toEqual({ kind: "builtin", name: "clear", args: "" });
    expect(slashAction("/model opus", [])).toEqual({ kind: "builtin", name: "model", args: "opus" });
    expect(slashAction("/resume", [])).toEqual({ kind: "terminalOnly", name: "resume" });
    expect(slashAction("/reload-plugins", ["reload-plugins"])).toEqual({ kind: "terminalOnly", name: "reload-plugins" });
    expect(slashAction("/graphify .", [])).toEqual({ kind: "send" });
    expect(slashAction("hola", [])).toEqual({ kind: "send" });
  });

  it("el menú pone los de la app primero y filtra", () => {
    const menu = slashMenu("", ["compact", "graphify", "doctor", "__remote", "code-review"], ["doctor"]);
    expect(menu.map((e) => e.name)).toEqual(["clear", "model", "mode", "compact", "graphify", "code-review"]);
    expect(slashMenu("rev", ["code-review", "review-pr"], []).map((e) => e.name)).toEqual(["review-pr", "code-review"]);
  });

  it("el menú se abre solo con una barra al principio y sin espacios", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/mo")).toBe("mo");
    expect(slashQuery("/model x")).toBeNull();
    expect(slashQuery("hola")).toBeNull();
  });
});

describe("menciones y modelos", () => {
  it("cita las rutas con espacios y marca las carpetas", () => {
    expect(mention("src/a.ts")).toBe("@src/a.ts");
    expect(mention("/home/u/mis cosas/a.ts")).toBe('@"/home/u/mis cosas/a.ts"');
    expect(mention("src", true)).toBe("@src/");
  });

  it("muestra el modelo del init legible", () => {
    expect(modelLabel("claude-haiku-5-5")).toBe("Haiku 5.5");
    expect(modelLabel("claude-opus-5")).toBe("Opus 5");
    expect(modelLabel("otro")).toBe("otro");
    expect(modelLabel(null)).toBeNull();
  });
});
