import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Markdown renderizado, para leer una skill sin instalarla.
 *
 * ## Lo que NO hace, a propósito
 *
 * No renderiza HTML crudo. `react-markdown` lo ignora salvo que se le agregue `rehype-raw`,
 * y acá no se agrega: este texto viene de un repositorio ajeno, así que es entrada no
 * confiable. Un `<script>` o un `<iframe>` dentro de un SKILL.md no tiene por qué poder
 * ejecutarse en la ventana de la app.
 *
 * Las imágenes tampoco se cargan: bajar una imagen remota le cuenta al servidor de turno
 * que abriste esa skill, y en una app de escritorio eso es filtrar tu IP por mirar un
 * catálogo. Se muestra el texto alternativo.
 *
 * Los enlaces abren en el navegador del sistema. Navegar DENTRO del webview reemplazaría
 * la app entera por una página web, sin forma de volver.
 */
export function Markdown({ content }: { content: string }) {
  // El frontmatter no es prosa: sin sacarlo, los `---` se renderizan como una línea
  // horizontal y los campos como un párrafo suelto arriba de todo. Los datos que trae ya
  // se muestran aparte, en la cabecera.
  const body = useMemo(() => stripFrontmatter(content), [content]);

  return (
    <div className="flex flex-col gap-3 text-[12.5px] leading-relaxed text-gray-700 dark:text-gray-300">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <h1 className="text-base font-bold text-gray-900 dark:text-white mt-2" {...p} />,
          h2: (p) => <h2 className="text-sm font-bold text-gray-900 dark:text-white mt-3" {...p} />,
          h3: (p) => <h3 className="text-[13px] font-semibold text-gray-800 dark:text-gray-100 mt-2" {...p} />,
          p: (p) => <p className="my-1.5" {...p} />,
          ul: (p) => <ul className="list-disc pl-5 my-1.5 flex flex-col gap-1" {...p} />,
          ol: (p) => <ol className="list-decimal pl-5 my-1.5 flex flex-col gap-1" {...p} />,
          hr: () => <hr className="my-3 border-gray-200 dark:border-white/10" />,
          blockquote: (p) => (
            <blockquote
              className="border-l-2 border-gray-300 dark:border-white/15 pl-3 my-2
                text-gray-500 dark:text-gray-400"
              {...p}
            />
          ),
          code: ({ className, children, ...rest }) => {
            // `react-markdown` usa el mismo componente para el código en línea y para el
            // de bloque; el de bloque llega con una clase `language-*` y envuelto en <pre>.
            const isBlock = /language-/.test(className ?? "");
            return isBlock ? (
              <code className="font-mono text-[11.5px] block" {...rest}>{children}</code>
            ) : (
              <code
                className="font-mono text-[11.5px] px-1 py-0.5 rounded
                  bg-gray-100 dark:bg-white/8 text-gray-800 dark:text-gray-200"
                {...rest}
              >
                {children}
              </code>
            );
          },
          pre: (p) => (
            <pre
              className="my-2 p-3 rounded-lg overflow-x-auto
                bg-gray-100 dark:bg-black/30
                border border-gray-200 dark:border-white/8"
              {...p}
            />
          ),
          table: (p) => (
            <div className="my-2 overflow-x-auto">
              <table className="text-[11.5px] border-collapse" {...p} />
            </div>
          ),
          th: (p) => (
            <th className="text-left font-semibold px-2 py-1 border-b
              border-gray-200 dark:border-white/10" {...p} />
          ),
          td: (p) => <td className="px-2 py-1 border-b border-gray-100 dark:border-white/5" {...p} />,
          a: ({ href, children }) => (
            <button
              onClick={() => { if (href) openUrl(href).catch(console.error); }}
              className="text-blue-600 dark:text-blue-400 hover:underline text-left"
            >
              {children}
            </button>
          ),
          img: ({ alt }) => (
            <span className="text-[11px] italic text-gray-400 dark:text-white/30">
              {alt ? `🖼 ${alt}` : null}
            </span>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

/** Saca el bloque `---` inicial de un SKILL.md. Si no hay, devuelve el texto igual. */
export function stripFrontmatter(content: string): string {
  return splitFrontmatter(content).body;
}

/**
 * Separa el bloque `---` inicial del resto. `frontmatter` es su contenido, sin las rayas;
 * `null` si el archivo no tiene (y entonces `body` es el texto tal cual).
 */
export function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const text = content.replace(/^\uFEFF/, "");
  if (!/^---\r?\n/.test(text)) return { frontmatter: null, body: content };
  // El cierre tiene que estar al principio de una línea: un `---` en medio de la prosa
  // (una línea horizontal, por ejemplo) no cierra nada.
  const end = text.search(/\r?\n---[ \t]*(\r?\n|$)/);
  if (end === -1) return { frontmatter: null, body: content };
  return {
    frontmatter: text.slice(text.indexOf("\n") + 1, end),
    body: text.slice(text.indexOf("\n", end + 1) + 1).replace(/^\s*\n/, ""),
  };
}
