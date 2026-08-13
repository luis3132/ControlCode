import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const platform = process.env.TAURI_ENV_PLATFORM;
// @ts-expect-error process is a nodejs global
const isDebugBuild = !!process.env.TAURI_ENV_DEBUG;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // `@/` apunta a `src/`. Con carpetas por feature, los imports relativos entre features
  // (`../../../features/skills/store`) son ilegibles y se rompen al mover un archivo; el
  // alias los deja estables y dice de qué feature viene cada cosa.
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
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
    target: platform === "windows" ? "chrome105" : "safari13",
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
