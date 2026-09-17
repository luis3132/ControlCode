import { describe, expect, it } from "vitest";

import { composePickMessage, toTargetUrl } from "../composeMessage";
import type { PickedElement } from "../protocol";


const proxy = "http://127.0.0.1:40111";
const target = "http://localhost:5173";
const display = (url: string) => toTargetUrl(url, proxy, target);

const el = (over: Partial<PickedElement> = {}): PickedElement => ({
  url: `${proxy}/login`, title: "Login", selector: "form.login > button.primary", tag: "button",
  text: "Entrar", html: '<button class="primary"\n  type="submit">Entrar</button>',
  attributes: { type: "submit" }, rect: { x: 1, y: 2, width: 3, height: 4 },
  component: { framework: "React", name: "LoginForm" }, ...over,
});

// El texto va en inglés aunque la app esté en español: es un prompt, no interfaz. Lo
// único que queda tal cual lo escribió la persona es su nota.
describe("el mensaje para el agente", () => {
  it("lleva lo que sirve para encontrarlo en el código, con la URL del servidor", () => {
    const text = composePickMessage([el()], "  debería deshabilitarse mientras carga ", display);
    expect(text).toBe([
      "The user marked 1 element(s) in http://localhost:5173/login:",
      "",
      "1. <button> «Entrar»",
      "   component: LoginForm (React)",
      "   selector: form.login > button.primary",
      '   attributes: type="submit"',
      '   html: <button class="primary" type="submit">Entrar</button>',
      "",
      "Note from the user: debería deshabilitarse mientras carga",
    ].join("\n"));
  });

  it("repite la página solo cuando el elemento es de otra", () => {
    const text = composePickMessage(
      [el(), el({ url: `${proxy}/panel`, component: null, attributes: {}, text: "" })],
      "", display
    );
    expect(text).toContain("2. <button>\n   page: http://localhost:5173/panel");
    expect(text.match(/ page:/g)).toHaveLength(1);
    expect(text).not.toContain("Note from the user:");
  });

  it("sin elementos queda solo la nota", () => {
    expect(composePickMessage([], " hola ", display)).toBe("hola");
  });

  it("cada captura lleva su página y la ruta sola en su línea, después de los elementos", () => {
    const text = composePickMessage(
      [el({ component: null, attributes: {}, text: "" })],
      "el botón no se ve",
      display,
      [{ id: "s-abcd1234", url: `${proxy}/login`, path: "/tmp/controlcode/capturas/captura-1-abcd.png" }]
    );
    expect(text.split("\n").slice(-6)).toEqual([
      "Screenshots of the page annotated by the user (how they see it on screen; open each image to view it):",
      "",
      "1. [s-abcd1234] http://localhost:5173/login",
      "/tmp/controlcode/capturas/captura-1-abcd.png",
      "",
      "Note from the user: el botón no se ve",
    ]);
    expect(text.indexOf("The user marked")).toBe(0);
  });

  it("una captura sola, sin elementos ni nota, también es un mensaje", () => {
    const text = composePickMessage([], "", display, [{ id: "s-0f0f0f0f", url: "http://localhost:5173/", path: "C:\\Temp\\captura.png" }]);
    expect(text).toBe("Screenshots of the page annotated by the user (how they see it on screen; open each image to view it):\n\n1. [s-0f0f0f0f] http://localhost:5173/\nC:\\Temp\\captura.png");
  });

  it("una URL que no es del proxy no se toca", () => {
    expect(toTargetUrl("https://github.com/x", proxy, target)).toBe("https://github.com/x");
  });
});
