import { fileURLToPath, URL } from "node:url";

import { build } from "esbuild";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const platform = process.env.TAURI_ENV_PLATFORM;
// @ts-expect-error process is a nodejs global
const isDebugBuild = !!process.env.TAURI_ENV_DEBUG;

/**
 * `import fuente from "./archivo.ts?script"` — ese archivo compilado a JS, como string.
 *
 * Para el código que la app no corre sino que INYECTA en otra página: el selector de
 * elementos y el runtime del navegador de las tabs viven adentro del iframe del proyecto.
 * Se escriben en TS y los chequea tsc como a todo lo demás; lo único distinto es el
 * resultado, un script autocontenido (IIFE) en vez de un módulo del bundle.
 *
 * Se empaqueta (y no solo se transpila) para que ese script pueda importar módulos puros
 * —el serializador de la consola, el formato del snapshot— que así se prueban en Node
 * como el resto de la lógica, en vez de quedar enterrados en código que solo corre
 * adentro de una página.
 */
function scriptAsString(): Plugin {
  const SUFFIX = "?script";
  const root = fileURLToPath(new URL("./", import.meta.url));
  return {
    name: "controlcode:script-as-string",
    async load(id) {
      if (!id.endsWith(SUFFIX)) return null;
      const file = id.slice(0, -SUFFIX.length);
      const result = await build({
        entryPoints: [file],
        absWorkingDir: root,
        bundle: true,
        write: false,
        metafile: true,
        format: "iife",
        platform: "browser",
        // Corre dentro de la página del usuario, no del webview de la app: se apunta bajo.
        target: "es2019",
        minify: true,
        logLevel: "silent",
      });
      for (const input of Object.keys(result.metafile.inputs)) {
        this.addWatchFile(fileURLToPath(new URL(input, `file://${root}`)));
      }
      return `export default ${JSON.stringify(result.outputFiles[0].text)};`;
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), scriptAsString()],

  // `@/` apunta a `src/`. Con carpetas por feature, los imports relativos entre features
  // (`../../../features/skills/store`) son ilegibles y se rompen al mover un archivo; el
  // alias los deja estables y dice de qué feature viene cada cosa.
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },

  // Los tests corren en Node: lo que se prueba es lógica pura (el parser de flags, los
  // filtros, los reducers del store), no componentes montados — para eso haría falta un
  // DOM y no es lo que estos tests cubren.
  test: {
    environment: "node",
    include: ["src/**/tests/*.test.ts"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
        protocol: "ws",
        host,
        port: 1421,
      }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    // El bundle solo corre dentro del webview que empaqueta Tauri, no en navegadores
    // arbitrarios: se compila contra ese motor concreto (WebView2 en Windows, WebKit en
    // el resto) en vez de degradar sintaxis para browsers que nunca van a abrir esto.
    //
    // WebKit NO puede bajar de Safari 15. Estaba en `safari13` y rompió la terminal del
    // release: xterm trae `let r; f(r ||= {})`, Safari 13 no tiene asignación lógica, y
    // esbuild al bajarla Y minificar se come la declaración y deja `void 0 || (i = {})`,
    // una asignación a una variable que no existe. En un módulo eso es un ReferenceError,
    // que saltaba con la primera consulta de modo (DECRQM) de Claude Code y dejaba muerto
    // el parser de xterm. `tauri dev` no minifica, así que en desarrollo nunca se vio; lo
    // cuida `src/app/tests/buildTarget.test.ts`. Safari 15 es el último que llega a macOS
    // Catalina, así que no deja afuera a nadie que Tauri 2 soporte.
    target: platform === "windows" ? "chrome105" : "safari15",
    // Sin minificar y con sourcemaps en `tauri dev`/`tauri build --debug`, para que un
    // error apunte al .tsx real en vez de a una línea de bundle ilegible.
    minify: isDebugBuild ? false : "esbuild",
    sourcemap: isDebugBuild,
    rollupOptions: {
      output: {
        // Sin esto todo cae en un único chunk de ~900kB que hay que parsear entero antes
        // de pintar el primer frame. Separando las dependencias pesadas y estables, el
        // chunk propio de la app queda chico y solo él se reconstruye al iterar.
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          xterm: ["@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-web-links"],
          i18n: ["i18next", "react-i18next"],
        },
      },
    },
  },
}));
