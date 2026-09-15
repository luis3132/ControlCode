import { describe, expect, it } from "vitest";

import { composePickMessage, toTargetUrl, type ComposeLabels } from "../composeMessage";
import type { PickedElement } from "../protocol";

const labels: ComposeLabels = {
  header: (url) => `Elementos marcados en ${url}:`,
  page: "Página", selector: "Selector", component: "Componente", attributes: "Atributos", html: "HTML", note: "Nota",
  captures: "Capturas anotadas:",
};

const proxy = "http://127.0.0.1:40111";
const target = "http://localhost:5173";
const display = (url: string) => toTargetUrl(url, proxy, target);

const el = (over: Partial<PickedElement> = {}): PickedElement => ({
  url: `${proxy}/login`, title: "Login", selector: "form.login > button.primary", tag: "button",
  text: "Entrar", html: '<button class="primary"\n  type="submit">Entrar</button>',
  attributes: { type: "submit" }, rect: { x: 1, y: 2, width: 3, height: 4 },
  component: { framework: "React", name: "LoginForm" }, ...over,
});

describe("el mensaje para el agente", () => {
  it("lleva lo que sirve para encontrarlo en el código, con la URL del servidor", () => {
    const text = composePickMessage([el()], "  debería deshabilitarse mientras carga ", display, labels);
    expect(text).toBe([
      "Elementos marcados en http://localhost:5173/login:",
      "",
      "1. <button> «Entrar»",
      "   Componente: LoginForm (React)",
      "   Selector: form.login > button.primary",
      '   Atributos: type="submit"',
      '   HTML: <button class="primary" type="submit">Entrar</button>',
      "",
      "Nota: debería deshabilitarse mientras carga",
    ].join("\n"));
  });

  it("repite la página solo cuando el elemento es de otra", () => {
    const text = composePickMessage(
      [el(), el({ url: `${proxy}/panel`, component: null, attributes: {}, text: "" })],
      "", display, labels
    );
    expect(text).toContain("2. <button>\n   Página: http://localhost:5173/panel");
    expect(text.match(/Página:/g)).toHaveLength(1);
    expect(text).not.toContain("Nota:");
  });

  it("sin elementos queda solo la nota", () => {
    expect(composePickMessage([], " hola ", display, labels)).toBe("hola");
  });

  it("cada captura lleva su página y la ruta sola en su línea, después de los elementos", () => {
    const text = composePickMessage(
      [el({ component: null, attributes: {}, text: "" })],
      "el botón no se ve",
      display,
      labels,
      [{ url: `${proxy}/login`, path: "/tmp/controlcode/capturas/captura-1-abcd.png" }]
    );
    expect(text.split("\n").slice(-6)).toEqual([
      "Capturas anotadas:",
      "",
      "1. http://localhost:5173/login",
      "/tmp/controlcode/capturas/captura-1-abcd.png",
      "",
      "Nota: el botón no se ve",
    ]);
    expect(text.indexOf("Elementos marcados")).toBe(0);
  });

  it("una captura sola, sin elementos ni nota, también es un mensaje", () => {
    const text = composePickMessage([], "", display, labels, [{ url: "http://localhost:5173/", path: "C:\\Temp\\captura.png" }]);
    expect(text).toBe("Capturas anotadas:\n\n1. http://localhost:5173/\nC:\\Temp\\captura.png");
  });

  it("una URL que no es del proxy no se toca", () => {
    expect(toTargetUrl("https://github.com/x", proxy, target)).toBe("https://github.com/x");
  });
});
