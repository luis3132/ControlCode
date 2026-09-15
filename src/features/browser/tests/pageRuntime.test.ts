import { describe, expect, it } from "vitest";

import {
  callerOf, displayPath, formatConsoleArgs, formatValue, MAX_TEXT, toTransferable,
} from "../page/serialize";
import { formatNode, formatSnapshot, parseKeyCombo, parseTarget } from "../page/snapshotFormat";

describe("formatValue", () => {
  it("muestra los primitivos como una consola", () => {
    expect(formatValue("hola")).toBe("hola");
    expect(formatValue(42)).toBe("42");
    expect(formatValue(10n)).toBe("10n");
    expect(formatValue(undefined)).toBe("undefined");
    expect(formatValue(null)).toBe("null");
    expect(formatValue(function guardar() {})).toBe("ƒ guardar()");
  });

  /// Adentro de un objeto los strings van entre comillas: `{a: "1"}` y `{a: 1}` son dos
  /// bugs distintos, y sin comillas se leen igual.
  it("distingue un string de un número adentro de un objeto", () => {
    expect(formatValue({ a: "1", b: 1 })).toBe('{a: "1", b: 1}');
  });

  it("no se cuelga con una referencia circular", () => {
    const a: Record<string, unknown> = { nombre: "a" };
    a.yo = a;
    expect(formatValue(a)).toBe('{nombre: "a", yo: [Circular]}');
  });

  /// El mismo objeto dos veces NO es circular: marcarlo como tal escondería datos.
  it("un objeto repetido no es circular", () => {
    const shared = { x: 1 };
    expect(formatValue([shared, shared])).toBe("[{x: 1}, {x: 1}]");
  });

  it("un getter que tira no rompe el log", () => {
    const hostile = Object.defineProperty({}, "boom", { enumerable: true, get() { throw new Error("no"); } });
    expect(formatValue(hostile)).toBe("{boom: [getter que falla]}");
  });

  it("un error se muestra con su nombre y mensaje", () => {
    expect(formatValue(new TypeError("x is undefined"))).toBe("TypeError: x is undefined");
  });

  /// Un nodo del DOM se reconoce por su forma: en Node no hay `Element`, y en la página
  /// puede venir de otro documento, donde `instanceof` tampoco sirve.
  it("describe un nodo del DOM en vez de recorrerlo", () => {
    const button = { nodeType: 1, nodeName: "BUTTON", id: "enviar", className: "btn primary" };
    expect(formatValue(button)).toBe("<button#enviar.btn.primary>");
    expect(formatValue({ nodeType: 3, nodeName: "#text", textContent: "hola" })).toBe('#text "hola"');
  });

  it("recorta colecciones largas y objetos profundos", () => {
    const long = Array.from({ length: 30 }, (_, i) => i);
    expect(formatValue(long)).toMatch(/, …10 más\]$/);
    expect(formatValue({ a: { b: { c: { d: 1 } } } })).toBe("{a: {b: {c: {…}}}}");
  });

  it("Map y Set muestran su contenido", () => {
    expect(formatValue(new Map([["k", 1]]))).toBe('Map(1) {"k" => 1}');
    expect(formatValue(new Set([1, 2]))).toBe("Set(2) {1, 2}");
  });
});

describe("formatConsoleArgs", () => {
  it("aplica las sustituciones de formato", () => {
    expect(formatConsoleArgs(["%s tiene %d años", "Ana", "31.9"])).toBe("Ana tiene 31 años");
    expect(formatConsoleArgs(["valor: %o", { a: 1 }])).toBe("valor: {a: 1}");
  });

  /// `%c` es CSS para la consola del navegador: en texto plano es ruido, y su argumento
  /// (`color: red`) no puede terminar pegado al mensaje.
  it("descarta los estilos de %c con su argumento", () => {
    expect(formatConsoleArgs(["%cVite%c conectado", "color: blue", "", "extra"])).toBe("Vite conectado extra");
  });

  it("los argumentos que sobran se agregan al final", () => {
    expect(formatConsoleArgs(["hola", { a: 1 }, 3])).toBe("hola {a: 1} 3");
  });

  it("un % suelto se deja como está", () => {
    expect(formatConsoleArgs(["100%"])).toBe("100%");
  });

  it("recorta un log gigante", () => {
    const text = formatConsoleArgs(["x".repeat(MAX_TEXT * 2)]);
    expect(text.length).toBeLessThan(MAX_TEXT + 20);
  });
});

describe("toTransferable", () => {
  it("devuelve JSON plano, con lo que no se clona descrito", () => {
    const result = toTransferable({
      n: 1, s: "a", nada: undefined, inf: Infinity, nodo: { nodeType: 1, nodeName: "DIV" }, fn: () => 1,
    });
    expect(result).toEqual({ n: 1, s: "a", nada: null, inf: "Infinity", nodo: "<div>", fn: "ƒ fn()" });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe("callerOf", () => {
  /// V8 (WebView2 en Windows) y WebKit (el resto) escriben el stack distinto; el runtime
  /// corre en los dos.
  it("entiende el stack de V8 y salta el propio runtime", () => {
    const stack = [
      "Error",
      "    at con.<computed> (http://127.0.0.1:40111/__controlcode__/picker.js:1:2000)",
      "    at onSubmit (http://127.0.0.1:40111/src/Login.tsx?t=1712:42:9)",
      "    at HTMLUnknownElement.callCallback (http://127.0.0.1:40111/node_modules/.vite/deps/react-dom.js:3:1)",
    ].join("\n");
    expect(callerOf(stack)).toBe("/src/Login.tsx:42:9");
  });

  it("entiende el stack de WebKit", () => {
    const stack = [
      "@http://127.0.0.1:40111/__controlcode__/picker.js:1:2000",
      "onSubmit@http://127.0.0.1:40111/src/Login.tsx:42:9",
    ].join("\n");
    expect(callerOf(stack)).toBe("/src/Login.tsx:42:9");
  });

  it("sin stack no inventa un lugar", () => {
    expect(callerOf(undefined)).toBeUndefined();
    expect(callerOf("Error\n    at <anonymous>")).toBeUndefined();
  });

  it("la ruta se muestra sin origen ni query", () => {
    expect(displayPath("http://127.0.0.1:1/assets/app.js?v=3#x")).toBe("/assets/app.js");
    expect(displayPath("http://127.0.0.1:1")).toBe("/");
  });
});

describe("snapshot", () => {
  it("una línea por nodo, con ref, estado y valor", () => {
    expect(formatNode({ depth: 1, role: "textbox", name: "Email", ref: "e3", states: ["required", "focused"], value: "ana@" }))
      .toBe('  - textbox "Email" [ref=e3] [required] [focused] value="ana@"');
    expect(formatNode({ depth: 0, role: "link", name: "Inicio", ref: "e1", states: [], href: "/" }))
      .toBe('- link "Inicio" [ref=e1] → /');
  });

  it("el encabezado dice dónde está parada la página y avisa lo que se omitió", () => {
    const text = formatSnapshot([{ depth: 0, role: "heading", name: "Hola", states: ["level=1"] }], {
      url: "http://127.0.0.1:1/", title: "App", viewport: { width: 375, height: 667 },
      scrollY: 0, documentHeight: 2000, omitted: 12,
    });
    expect(text.split("\n")).toEqual([
      'page: "App" http://127.0.0.1:1/',
      "viewport: 375×667 · scroll 0/2000",
      "",
      '- heading "Hola" [level=1]',
      "… 12 nodos más (pedí el snapshot completo o hacé scroll)",
    ]);
  });
});

describe("parseTarget", () => {
  it("distingue un ref, un texto y un selector", () => {
    expect(parseTarget("e12")).toEqual({ kind: "ref", ref: "e12" });
    expect(parseTarget('text="Iniciar sesión"')).toEqual({ kind: "text", text: "Iniciar sesión" });
    expect(parseTarget("text:Guardar")).toEqual({ kind: "text", text: "Guardar" });
    expect(parseTarget("#login > button")).toEqual({ kind: "css", selector: "#login > button" });
  });

  /// `e12` es un ref, pero `.e12` o `e12x` son selectores: confundirlos haría fallar con
  /// "tomá un snapshot" a quien pasó un selector perfectamente válido.
  it("solo e + número es un ref", () => {
    expect(parseTarget("e12x").kind).toBe("css");
    expect(parseTarget(".e12").kind).toBe("css");
  });
});

describe("parseKeyCombo", () => {
  it("separa la tecla de sus modificadores", () => {
    expect(parseKeyCombo("Control+Shift+a")).toMatchObject({ key: "a", ctrlKey: true, shiftKey: true, altKey: false });
    expect(parseKeyCombo("Enter")).toMatchObject({ key: "Enter", ctrlKey: false });
    expect(parseKeyCombo("Meta+k")).toMatchObject({ key: "k", metaKey: true });
  });

  it("la tecla + también se puede apretar", () => {
    expect(parseKeyCombo("Control++")).toMatchObject({ key: "+", ctrlKey: true });
    expect(parseKeyCombo("+").key).toBe("+");
  });
});
