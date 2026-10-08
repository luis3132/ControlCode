import { describe, expect, it } from "vitest";

import { withLaunchArgs } from "@/features/sessions/agentResume";

import { answersOf, questionsOf } from "../QuestionCard";

describe("preguntas del agente", () => {
  const input = {
    questions: [
      { question: "¿Color?", header: "Color", options: [{ label: "Rojo" }, { label: "Azul" }], multiSelect: false },
      { question: "¿Qué partes?", options: [{ label: "API" }, { label: "UI" }], multiSelect: true },
      { nada: true },
    ],
  };

  it("lee las preguntas e ignora lo que no tiene forma", () => {
    expect(questionsOf(input).map((q) => q.question)).toEqual(["¿Color?", "¿Qué partes?"]);
    expect(questionsOf({})).toEqual([]);
  });

  it("junta lo elegido y lo escrito; lo que no se contestó no va", () => {
    const qs = questionsOf(input);
    expect(answersOf(qs, { "¿Color?": ["Azul"], "¿Qué partes?": ["API", "UI"] }, { "¿Qué partes?": " docs " }))
      .toEqual({ "¿Color?": "Azul", "¿Qué partes?": "API, UI, docs" });
    expect(answersOf(qs, {}, { "¿Color?": "  " })).toEqual({});
  });
});

describe("withLaunchArgs", () => {
  it("agrega los flags y cita lo que tiene espacios", () => {
    expect(withLaunchArgs("claude --resume s1", ["--model", "claude-opus-5-5", "--effort", "high"]))
      .toBe("claude --resume s1 --model claude-opus-5-5 --effort high");
    expect(withLaunchArgs("claude", ["--model", "mi modelo"])).toBe('claude --model "mi modelo"');
    expect(withLaunchArgs("claude", undefined)).toBe("claude");
  });
});
