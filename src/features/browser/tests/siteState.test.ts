import { describe, expect, it } from "vitest";

import { cookieLine, cookiePairs, entriesOf, restoreInto, signatureOf } from "../page/siteState";

/** Un `Storage` en memoria: en Node no hay uno, y alcanza con la interfaz. */
class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  constructor(private quota = Infinity) {}
  get length() { return this.items.size; }
  key(i: number) { return [...this.items.keys()][i] ?? null; }
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (this.items.size >= this.quota) throw new Error("QuotaExceededError");
    this.items.set(key, String(value));
  }
  removeItem(key: string) { this.items.delete(key); }
  clear() { this.items.clear(); }
  [name: string]: unknown;
}

const setItem = MemoryStorage.prototype.setItem as Storage["setItem"];

describe("cookies de la página", () => {
  it("document.cookie se parte en pares como los devuelve cookieStore", () => {
    expect(cookiePairs("a=1; b=x=y;  ; sola")).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "x=y" },
      { name: "", value: "sola" },
    ]);
    expect(cookiePairs("")).toEqual([]);
  });

  it("cookieStore.set y delete se dicen como una asignación a document.cookie", () => {
    expect(cookieLine({ name: "tema", value: "oscuro" })).toBe("tema=oscuro; path=/");
    expect(cookieLine({ name: "tema", value: "o", path: "/app", sameSite: "strict", expires: 0 }))
      .toBe("tema=o; path=/app; expires=Thu, 01 Jan 1970 00:00:00 GMT; samesite=strict");
    expect(cookieLine({ name: "tema", path: "/app" }, true)).toBe("tema=; path=/app; max-age=0");
  });
});

describe("la copia del storage", () => {
  it("se lee en el orden del navegador", () => {
    const s = new MemoryStorage();
    s.setItem("b", "2");
    s.setItem("a", "1");
    expect(entriesOf(s)).toEqual([["b", "2"], ["a", "1"]]);
    expect(entriesOf(null)).toBeNull();
  });

  /// La firma se calcula cada pocos segundos: tiene que cambiar con lo que cambia (una
  /// asignación directa `localStorage.x = …` no pasa por setItem) sin serializar valores.
  it("la firma cambia cuando cambia una clave o el largo de un valor", () => {
    const s = new MemoryStorage();
    s.setItem("token", "abc");
    const before = signatureOf(s);
    s.setItem("token", "abcd");
    expect(signatureOf(s)).not.toBe(before);
    const same = signatureOf(s);
    s.setItem("token", "wxyz");
    expect(signatureOf(s)).toBe(same); // mismo largo: lo agarran los métodos, no la firma
    s.removeItem("token");
    expect(signatureOf(s)).toBe("0");
  });

  it("se repone solo en un área vacía", () => {
    const empty = new MemoryStorage();
    expect(restoreInto(empty, [["token", "xyz"], ["tema", "oscuro"]], setItem)).toBe(2);
    expect(empty.getItem("token")).toBe("xyz");

    // Si el motor conservó la suya, esa es la que vale.
    const kept = new MemoryStorage();
    kept.setItem("token", "nuevo");
    expect(restoreInto(kept, [["token", "viejo"]], setItem)).toBe(0);
    expect(kept.getItem("token")).toBe("nuevo");
  });

  it("sin cuota repone lo que entra y no tira", () => {
    const tight = new MemoryStorage(1);
    expect(restoreInto(tight, [["a", "1"], ["b", "2"]], setItem)).toBe(1);
    expect(restoreInto(new MemoryStorage(), null, setItem)).toBe(0);
  });
});
