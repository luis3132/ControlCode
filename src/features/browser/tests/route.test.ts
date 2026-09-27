import { describe, expect, it } from "vitest";

import { corsMessage, routeRequest } from "../page/route";

const page = "http://localhost:47567/app/index.html";
const target = "http://localhost:5173";

describe("adónde va un pedido de la página", () => {
  it("lo relativo y lo del propio proxy no se toca", () => {
    expect(routeRequest("/api/x", page, target)).toBeNull();
    expect(routeRequest("data.json", page, target)).toBeNull();
    expect(routeRequest("http://localhost:47567/y", page, target)).toBeNull();
    expect(routeRequest("data:text/plain,hola", page, target)).toBeNull();
    expect(routeRequest("blob:http://localhost:47567/abc", page, target)).toBeNull();
  });

  it("al propio servidor por URL absoluta va por la ruta del proxy", () => {
    expect(routeRequest("http://localhost:5173/data.json?a=1#x", page, target)).toEqual({
      url: "http://localhost:47567/data.json?a=1#x",
      forwarded: false,
      original: "http://localhost:5173/data.json?a=1#x",
    });
  });

  it("a otro origen va por el reenvío, sin el fragmento", () => {
    const routed = routeRequest("http://localhost:8080/me?x=1#frag", page, target)!;
    expect(routed.forwarded).toBe(true);
    expect(routed.url).toBe(`http://localhost:47567/__controlcode__/fwd?url=${encodeURIComponent("http://localhost:8080/me?x=1")}`);
    expect(routed.original).toBe("http://localhost:8080/me?x=1#frag");
    expect(routeRequest("https://api.ejemplo.com/v1", page, target)?.forwarded).toBe(true);
  });

  it("sin el origen real (un proxy viejo), el propio servidor se trata como otro origen", () => {
    expect(routeRequest("http://localhost:5173/x", page, null)?.forwarded).toBe(true);
  });

  it("el mensaje de CORS se lee como el de un navegador", () => {
    expect(corsMessage("http://localhost:8080/me", target, "falta el encabezado"))
      .toBe("Access to http://localhost:8080/me from origin 'http://localhost:5173' has been blocked by CORS policy: falta el encabezado");
  });
});
