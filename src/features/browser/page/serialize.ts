/**
 * Cómo se convierte lo que hay en la página en texto: los argumentos de un `console.log`,
 * el resultado de un `eval`, el lugar del código desde donde se logueó.
 *
 * Puro y sin DOM a propósito: corre adentro de la página (lo empaqueta `page/runtime.ts`)
 * pero se prueba en Node. Nada de `instanceof Element` — un nodo se reconoce por su forma,
 * que además funciona con nodos de otro documento (un iframe adentro de la página).
 */

/** Tope de un texto de consola. Una página que loguea un JSON de 2 MB no puede llenar el
 *  panel ni, sobre todo, el contexto del agente que lo lee. */
export const MAX_TEXT = 4000;

const MAX_ITEMS = 20;
const MAX_DEPTH = 3;

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (+${text.length - max})` : text;
}

interface NodeLike {
  nodeType: number;
  nodeName: string;
  id?: string;
  className?: unknown;
  textContent?: string | null;
}

function isNodeLike(value: object): value is NodeLike {
  const v = value as Partial<NodeLike>;
  return typeof v.nodeType === "number" && typeof v.nodeName === "string";
}

/** `<button#enviar.btn.primary>`, o `#text "hola"` para un nodo de texto. */
export function describeNode(node: NodeLike): string {
  if (node.nodeType === 3) return `#text ${JSON.stringify(clip(node.textContent ?? "", 60))}`;
  if (node.nodeType === 9) return "#document";
  const tag = node.nodeName.toLowerCase();
  const id = node.id ? `#${node.id}` : "";
  // `className` de un SVG es un `SVGAnimatedString`, no un string.
  const classes = typeof node.className === "string" && node.className.trim()
    ? `.${node.className.trim().split(/\s+/).slice(0, 3).join(".")}`
    : "";
  return `<${tag}${id}${classes}>`;
}

function describeError(error: { name?: unknown; message?: unknown }): string {
  const name = typeof error.name === "string" && error.name ? error.name : "Error";
  const message = typeof error.message === "string" ? error.message : "";
  return message ? `${name}: ${message}` : name;
}

function isErrorLike(value: object): value is Error {
  if (value instanceof Error) return true;
  const v = value as Partial<Error>;
  return typeof v.message === "string" && typeof v.stack === "string";
}

/**
 * Un valor como lo mostraría una consola, en una línea.
 *
 * Nunca tira: un getter que explota, un Proxy hostil o una referencia circular se
 * muestran como tales en vez de romper el log de la página que se está depurando.
 */
export function formatValue(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): string {
  try {
    if (value === null) return "null";
    switch (typeof value) {
      case "undefined": return "undefined";
      case "string": return depth === 0 ? value : JSON.stringify(clip(value, 200));
      case "number":
      case "boolean": return String(value);
      case "bigint": return `${value}n`;
      case "symbol": return value.toString();
      case "function": return `ƒ ${value.name || "anónima"}()`;
    }
    const obj = value as object;
    if (seen.has(obj)) return "[Circular]";
    if (isNodeLike(obj)) return describeNode(obj);
    if (isErrorLike(obj)) return describeError(obj);
    if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? "Invalid Date" : obj.toISOString();
    if (obj instanceof RegExp) return String(obj);

    seen.add(obj);
    try {
      if (depth >= MAX_DEPTH) return Array.isArray(obj) ? `Array(${obj.length})` : "{…}";

      if (obj instanceof Map) {
        const items = Array.from(obj.entries()).slice(0, MAX_ITEMS)
          .map(([k, v]) => `${formatValue(k, depth + 1, seen)} => ${formatValue(v, depth + 1, seen)}`);
        return `Map(${obj.size}) {${items.join(", ")}${obj.size > MAX_ITEMS ? ", …" : ""}}`;
      }
      if (obj instanceof Set) {
        const items = Array.from(obj.values()).slice(0, MAX_ITEMS).map((v) => formatValue(v, depth + 1, seen));
        return `Set(${obj.size}) {${items.join(", ")}${obj.size > MAX_ITEMS ? ", …" : ""}}`;
      }
      if (Array.isArray(obj)) {
        const items = obj.slice(0, MAX_ITEMS).map((v) => formatValue(v, depth + 1, seen));
        const rest = obj.length > MAX_ITEMS ? `, …${obj.length - MAX_ITEMS} más` : "";
        return `[${items.join(", ")}${rest}]`;
      }

      const keys = Object.keys(obj);
      const entries = keys.slice(0, MAX_ITEMS).map((k) => {
        let v: unknown;
        try {
          v = (obj as Record<string, unknown>)[k];
        } catch {
          return `${k}: [getter que falla]`;
        }
        return `${k}: ${formatValue(v, depth + 1, seen)}`;
      });
      const rest = keys.length > MAX_ITEMS ? `, …${keys.length - MAX_ITEMS} más` : "";
      const ctor = (obj as { constructor?: { name?: string } }).constructor?.name;
      const prefix = ctor && ctor !== "Object" ? `${ctor} ` : "";
      return `${prefix}{${entries.join(", ")}${rest}}`;
    } finally {
      seen.delete(obj);
    }
  } catch {
    return "[no se puede mostrar]";
  }
}

/**
 * Los argumentos de un `console.*` como una línea, con las sustituciones de formato
 * (`%s`, `%d`, `%o`…) que usan las librerías. `%c` (estilos) se descarta junto con su
 * argumento: en texto plano no significa nada.
 */
export function formatConsoleArgs(args: unknown[]): string {
  if (args.length === 0) return "";
  const [first, ...rest] = args;
  const parts: string[] = [];

  if (typeof first === "string" && first.includes("%")) {
    let i = 0;
    const replaced = first.replace(/%([sdifoOc%])/g, (match, spec: string) => {
      if (spec === "%") return "%";
      if (i >= rest.length) return match;
      const arg = rest[i++];
      switch (spec) {
        case "c": return "";
        case "s": return typeof arg === "string" ? arg : formatValue(arg, 1);
        case "d":
        case "i": return String(Number.parseInt(String(arg), 10));
        case "f": return String(Number.parseFloat(String(arg)));
        default: return formatValue(arg, 1);
      }
    });
    parts.push(replaced);
    parts.push(...rest.slice(i).map((a) => formatValue(a)));
  } else {
    parts.push(...args.map((a) => formatValue(a)));
  }
  return clip(parts.join(" "), MAX_TEXT);
}

/**
 * Un valor convertido a algo que viaja por `postMessage` y se lee como JSON: lo que
 * devuelve un `eval` del agente. Los nodos, funciones y errores van descritos, no
 * clonados (clonarlos tira o arrastra el DOM entero).
 */
export function toTransferable(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "undefined") return null;
  if (typeof value !== "object") return formatValue(value);
  const obj = value as object;
  if (seen.has(obj)) return "[Circular]";
  if (isNodeLike(obj) || isErrorLike(obj) || obj instanceof Date || obj instanceof RegExp) {
    return formatValue(obj);
  }
  if (depth >= 4) return formatValue(obj, MAX_DEPTH);
  seen.add(obj);
  try {
    if (obj instanceof Map) {
      return Object.fromEntries(Array.from(obj.entries()).slice(0, 50)
        .map(([k, v]) => [formatValue(k), toTransferable(v, depth + 1, seen)]));
    }
    if (obj instanceof Set || Array.isArray(obj)) {
      return Array.from(obj as Iterable<unknown>).slice(0, 100).map((v) => toTransferable(v, depth + 1, seen));
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).slice(0, 100)) {
      try {
        out[key] = toTransferable((obj as Record<string, unknown>)[key], depth + 1, seen);
      } catch {
        out[key] = "[getter que falla]";
      }
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Desde dónde se llamó, sacado de un `stack`: la primera línea que no es del propio
 * runtime. Entiende los dos formatos que importan — V8 (`at f (url:1:2)`) y WebKit /
 * Gecko (`f@url:1:2`) —, porque la app corre sobre WebView2 en Windows y WebKit en el
 * resto.
 *
 * La URL se muestra sin el origen del proxy ni el `?t=` que agregan los servidores de
 * desarrollo: `/src/App.tsx:12:5` es lo que alguien busca en el repo.
 */
export function callerOf(stack: string | undefined, ownMarker = "/__controlcode__/"): string | undefined {
  if (!stack) return undefined;
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    if (!line || line.includes(ownMarker)) continue;
    const match = /(?:\(|@|at )((?:https?|file|blob|webpack|vite):[^\s)]*?):(\d+):(\d+)\)?$/.exec(line);
    if (match) return `${displayPath(match[1])}:${match[2]}:${match[3]}`;
  }
  return undefined;
}

/** `http://localhost:41234/src/App.tsx?t=17` → `/src/App.tsx`. */
export function displayPath(url: string): string {
  const noQuery = url.replace(/[?#].*$/, "");
  const match = /^https?:\/\/[^/]+(\/.*)?$/.exec(noQuery);
  return match ? (match[1] ?? "/") : noQuery;
}
