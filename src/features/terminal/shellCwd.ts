/**
 * En qué carpeta quedó cada tab de terminal pelada, para volver ahí al reabrir la app.
 *
 * `tab.cwd` no cambia con los `cd`: es la carpeta del workspace, y lo que agrupa las tabs.
 * Esto va aparte y en `localStorage`, como las tabs de archivo (ver `viewStore`): es
 * comodidad de esta máquina, y perderlo solo significa volver a la carpeta del workspace.
 *
 * Se entera de dos formas:
 * - **La secuencia que manda el shell** al cambiar de carpeta: OSC 7 (`file://host/ruta`,
 *   bash/zsh/fish con integración de terminal) u OSC 9;9 (`"C:\ruta"`, la que emite el
 *   PowerShell que lanza la app en Windows). Ver `parseCwdOsc`.
 * - **Preguntándole al sistema** al guardar (`pty_cwd`), donde se puede: Linux y macOS.
 */
const KEY = "cc-shell-cwd";

function read(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function write(map: Record<string, string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* sin recordarla, la tab vuelve a la carpeta del workspace */
  }
}

/** Cuántas se recuerdan. Las ventanas comparten este almacenamiento, así que no se poda
 *  por las tabs de una: se guardan las últimas, y una tab cerrada hace rato se cae sola. */
const MAX = 200;

export function rememberShellCwd(tabId: string, path: string): void {
  const map = read();
  if (map[tabId] === path) return;
  // Al final del objeto: el orden de inserción dice cuál se tocó último.
  delete map[tabId];
  map[tabId] = path;
  const ids = Object.keys(map);
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX))) delete map[old];
  write(map);
}

export function shellCwdOf(tabId: string): string | null {
  return read()[tabId] ?? null;
}

/**
 * La carpeta que trae una secuencia OSC del shell, o `null` si no es de las que dicen eso.
 * `ident` es el número de la OSC y `data` lo que sigue al `;`.
 */
export function parseCwdOsc(ident: number, data: string): string | null {
  if (ident === 7) {
    // `file://host/home/u/x` — el host se ignora; la ruta viene codificada como URL.
    const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
    if (!m) return null;
    try {
      const path = decodeURIComponent(m[1]);
      // `file://host/C:/x` en Windows: sin la barra de adelante.
      return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
    } catch {
      return null;
    }
  }
  if (ident === 9 && data.startsWith("9;")) {
    const path = data.slice(2).trim().replace(/^"(.*)"$/, "$1");
    return path || null;
  }
  return null;
}
