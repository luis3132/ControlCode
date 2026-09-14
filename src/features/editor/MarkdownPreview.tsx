import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button, CheckIcon, CopyIcon, useTheme } from "neogestify-ui-components";

import { splitFrontmatter } from "@/shared/ui/Markdown";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { isLocalUrl } from "@/features/tabs/viewTabs";
import { TERMINAL_FONT } from "@/features/terminal/theme";

import { highlightLines, type Span } from "./highlight";
import { readFile } from "./ipc";
import { classifyDocLink, isRemoteSource, parseFrontmatter, resolveDocPath } from "./markdown";
import { MARKDOWN_REHYPE, MARKDOWN_REMARK, textOf } from "./markdownPipeline";

/** Lo que los componentes del documento necesitan saber de la tab en que están. */
interface PreviewEnv {
  path: string;
  cwd: string;
  dark: boolean;
  remoteImages: boolean;
  loadRemoteImages: () => void;
  follow: (href: string | undefined) => void;
  /** Imágenes locales ya pedidas: el documento se vuelve a renderizar con cada cambio. */
  images: Map<string, Promise<string | null>>;
}

const Env = createContext<PreviewEnv | null>(null);

function useEnv(): PreviewEnv {
  const env = useContext(Env);
  if (!env) throw new Error("MarkdownPreview: componente fuera de la vista previa");
  return env;
}

/** Hay imágenes de internet en el documento, en sintaxis Markdown o en HTML. */
const REMOTE_IMAGE = /!\[[^\]]*\]\(\s*<?(?:https?:)?\/\/|<img[^>]*\ssrc\s*=\s*["']?(?:https?:)?\/\//i;

/**
 * Un Markdown del disco, renderizado para leerlo.
 *
 * Lo que se muestra es lo que tiene el editor, cambios sin guardar incluidos (ver
 * `FileTab`). El HTML se interpreta y se sanea como en GitHub (ver `markdownPipeline.ts`).
 *
 * Los enlaces no navegan el webview —eso reemplazaría la app por una página—: un `#título`
 * lleva a su sección, otro archivo se abre como tab, un servidor local se abre en una tab
 * de navegador, y el resto va al navegador del sistema.
 *
 * Las imágenes del repo se leen del disco. Las de internet no se cargan solas: pedirlas le
 * avisa a cada servidor que abriste el archivo, y un repo clonado puede traer las que
 * quiera. Se muestran cuando el usuario lo pide, por documento.
 */
export default function MarkdownPreview({ source, path, cwd }: { source: string; path: string; cwd: string }) {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const scroller = useRef<HTMLDivElement>(null);
  const [remoteImages, setRemoteImages] = useState(false);
  const images = useRef(new Map<string, Promise<string | null>>());

  const { frontmatter, body } = useMemo(() => splitFrontmatter(source), [source]);
  const fields = useMemo(() => (frontmatter ? parseFrontmatter(frontmatter) : []), [frontmatter]);
  const hasRemoteImages = useMemo(() => REMOTE_IMAGE.test(body), [body]);
  // GFM rotula las notas al pie en inglés.
  const footnotes = useMemo(() => ({
    footnoteLabel: t("editor.preview.footnotes"),
    footnoteBackLabel: t("editor.preview.footnoteBack"),
  }), [t]);

  const scrollTo = useCallback((id: string) => {
    const root = scroller.current;
    if (!root) return;
    const candidates = [id, id.toLowerCase(), `user-content-${id}`];
    const target = candidates
      .map((candidate) => root.querySelector(`[id="${CSS.escape(candidate)}"], [name="${CSS.escape(`user-content-${candidate}`)}"]`))
      .find(Boolean);
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  const follow = useCallback((href: string | undefined) => {
    const link = classifyDocLink(href, path, cwd);
    const views = useViewTabsStore.getState();
    if (link.kind === "anchor") scrollTo(link.id);
    else if (link.kind === "file") views.openFile(cwd, link.path);
    else if (link.kind === "url") {
      if (isLocalUrl(link.url)) views.openBrowser(cwd, link.url);
      else openUrl(link.url).catch(console.error);
    }
  }, [path, cwd, scrollTo]);

  const env = useMemo<PreviewEnv>(() => ({
    path, cwd, dark: theme === "dark", remoteImages, follow,
    loadRemoteImages: () => setRemoteImages(true),
    images: images.current,
  }), [path, cwd, theme, remoteImages, follow]);

  return (
    <Env.Provider value={env}>
      <div ref={scroller} tabIndex={-1} className="h-full overflow-auto outline-none bg-white dark:bg-[#0d1117]">
        {hasRemoteImages && !remoteImages && (
          <div className="sticky top-0 z-10 flex items-center gap-3 px-6 py-1.5 text-[11.5px]
            bg-gray-50/95 dark:bg-[#0a0f16]/95 backdrop-blur
            text-gray-500 dark:text-white/45 border-b border-gray-200 dark:border-white/7">
            <span className="flex-1 min-w-0">{t("editor.preview.remoteImages")}</span>
            <Button size="sm" variant="ghost" onClick={() => setRemoteImages(true)}>
              {t("editor.preview.loadRemote")}
            </Button>
          </div>
        )}

        <article className="mx-auto max-w-[860px] px-10 py-8 text-[14.5px] leading-[1.7]
          text-gray-800 dark:text-[#d1d7e0] [&>*:first-child]:mt-0 break-words">
          {fields.length > 0 && <FrontmatterTable fields={fields} />}
          <ReactMarkdown
            remarkPlugins={MARKDOWN_REMARK}
            rehypePlugins={MARKDOWN_REHYPE}
            remarkRehypeOptions={footnotes}
            components={COMPONENTS}
          >
            {body}
          </ReactMarkdown>
        </article>
      </div>
    </Env.Provider>
  );
}

function FrontmatterTable({ fields }: { fields: [string, string][] }) {
  return (
    <div className="mb-6 overflow-x-auto">
      <table className="w-full border-collapse text-[12.5px]">
        <tbody>
          {fields.map(([key, value]) => (
            <tr key={key} className="border-b border-gray-200 dark:border-white/8">
              <th className="py-1.5 pr-4 text-left align-top font-medium whitespace-nowrap text-gray-500 dark:text-white/45">
                {key}
              </th>
              <td className="py-1.5 whitespace-pre-wrap" style={{ fontFamily: value.includes("\n") ? TERMINAL_FONT : undefined }}>
                {value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Props<Tag extends keyof React.JSX.IntrinsicElements> = React.JSX.IntrinsicElements[Tag] & ExtraProps;

function PreviewLink({ href, children, node: _node, ...rest }: Props<"a">) {
  const { follow } = useEnv();
  return (
    <a
      {...rest}
      href={href}
      title={href}
      onClick={(event) => {
        event.preventDefault();
        follow(href);
      }}
      className="text-blue-600 dark:text-[#4493f8] underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}

/** Una imagen local, como data URL. Un SVG llega como texto y se envuelve: dentro de un
 *  `<img>` no ejecuta nada. */
function loadLocalImage(env: PreviewEnv, src: string): Promise<string | null> {
  const absolute = resolveDocPath(env.path, src.split(/[?#]/)[0], env.cwd);
  let pending = env.images.get(absolute);
  if (!pending) {
    pending = readFile(absolute)
      .then((file) => {
        if (file.kind === "image") return file.dataUrl;
        if (file.kind === "text" && /\.svg$/i.test(absolute)) {
          return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.content)}`;
        }
        return null;
      })
      .catch(() => null);
    env.images.set(absolute, pending);
  }
  return pending;
}

function PreviewImage({ src, alt, node: _node, ...rest }: Props<"img">) {
  const env = useEnv();
  const { t } = useTranslation();
  const source = typeof src === "string" ? src : "";
  const remote = source !== "" && isRemoteSource(source);
  const [local, setLocal] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!source || remote) return;
    let alive = true;
    loadLocalImage(env, source).then((url) => { if (alive) setLocal(url); });
    return () => { alive = false; };
  }, [env, source, remote]);

  const chip = (label: string, onClick?: () => void) => (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      title={onClick ? t("editor.preview.loadRemote") : source}
      className="inline-flex items-center gap-1 max-w-full px-1.5 py-0.5 mx-0.5 align-middle rounded
        text-[11px] leading-tight text-gray-500 dark:text-white/45
        bg-gray-100 dark:bg-white/6 border border-gray-200 dark:border-white/10
        enabled:hover:text-gray-800 enabled:dark:hover:text-white"
    >
      <span aria-hidden>🖼</span>
      <span className="truncate">{label}</span>
    </button>
  );

  if (!source) return alt ? chip(alt) : null;
  if (remote) {
    if (!env.remoteImages) return chip(alt || hostOf(source), env.loadRemoteImages);
    return <img {...rest} src={source.startsWith("//") ? `https:${source}` : source} alt={alt} className="inline max-w-full align-middle" />;
  }
  if (local === undefined) return <span className="inline-block w-4 h-4 align-middle" />;
  if (local === null) return chip(alt || source);
  return <img {...rest} src={local} alt={alt} className="inline max-w-full align-middle" />;
}

function hostOf(url: string): string {
  try {
    return new URL(url.startsWith("//") ? `https:${url}` : url).hostname;
  } catch {
    return url;
  }
}

/** Un bloque de código: con los colores del editor cuando se conoce el lenguaje, y un botón
 *  para copiarlo. */
function CodeBlock({ node }: Props<"pre">) {
  const { dark } = useEnv();
  const { t } = useTranslation();
  const code = node?.children.find((child) => child.type === "element" && child.tagName === "code");
  const text = textOf(code).replace(/\n$/, "");
  const classes = code?.type === "element" ? code.properties.className : undefined;
  const language = (Array.isArray(classes) ? classes : [])
    .map(String)
    .find((name) => name.startsWith("language-"))
    ?.slice("language-".length);
  const [lines, setLines] = useState<Span[][] | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setLines(null);
    if (!language) return;
    let alive = true;
    highlightLines(text, language, dark)
      .then((result) => { if (alive) setLines(result); })
      .catch(() => {});
    return () => { alive = false; };
  }, [text, language, dark]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="group relative my-4">
      <pre
        className="overflow-x-auto rounded-lg px-4 py-3 text-[12.5px] leading-[1.55]
          bg-[#f6f8fa] dark:bg-[#151b23] border border-gray-200 dark:border-white/8"
        style={{ fontFamily: TERMINAL_FONT }}
      >
        <code>
          {lines
            ? lines.map((line, i) => (
              <Fragment key={i}>
                {line.map((span, j) => <span key={j} className={span.className}>{span.text}</span>)}
                {i < lines.length - 1 && "\n"}
              </Fragment>
            ))
            : text}
        </code>
      </pre>
      <button
        type="button"
        onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(console.error)}
        aria-label={t(copied ? "editor.preview.copied" : "editor.preview.copy")}
        title={t(copied ? "editor.preview.copied" : "editor.preview.copy")}
        className="cc-t absolute top-2 right-2 flex items-center justify-center w-7 h-7 rounded-md
          opacity-0 group-hover:opacity-100 focus-visible:opacity-100
          text-gray-500 dark:text-white/50 hover:text-gray-900 dark:hover:text-white
          bg-white/90 dark:bg-[#0d1117]/90 border border-gray-200 dark:border-white/10"
      >
        {copied ? <CheckIcon className="w-3.5 h-3.5 text-emerald-500" /> : <CopyIcon className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

const heading = "font-semibold text-gray-900 dark:text-[#f0f6fc] leading-tight scroll-mt-4";

const COMPONENTS: Components = {
  h1: ({ node: _n, ...p }) => <h1 {...p} className={`${heading} text-[1.9em] mt-8 mb-4 pb-2 border-b border-gray-200 dark:border-white/10`}/>,
  h2: ({ node: _n, ...p }) => <h2 {...p} className={`${heading} text-[1.45em] mt-8 mb-4 pb-1.5 border-b border-gray-200 dark:border-white/10`}/>,
  h3: ({ node: _n, ...p }) => <h3 {...p} className={`${heading} text-[1.2em] mt-6 mb-3`}/>,
  h4: ({ node: _n, ...p }) => <h4 {...p} className={`${heading} text-[1em] mt-6 mb-3`}/>,
  h5: ({ node: _n, ...p }) => <h5 {...p} className={`${heading} text-[0.9em] mt-5 mb-2`}/>,
  h6: ({ node: _n, ...p }) => <h6 {...p} className={`${heading} text-[0.85em] mt-5 mb-2 text-gray-500 dark:text-white/50`}/>,
  p: ({ node: _n, ...p }) => <p {...p} className="my-3"/>,
  a: PreviewLink,
  img: PreviewImage,
  pre: CodeBlock,
  code: ({ node: _n, ...p }) => (
    <code {...p}
      className="px-1.5 py-0.5 rounded-md text-[0.86em] bg-gray-100 dark:bg-white/10 text-gray-800 dark:text-[#e6edf3]"
      style={{ fontFamily: TERMINAL_FONT }}/>
  ),
  ul: ({ node: _n, className, ...p }) => (
    <ul {...p}
      className={`my-3 pl-6 space-y-1 [&_ul]:my-1 [&_ol]:my-1 ${
        className?.includes("contains-task-list") ? "list-none pl-1" : "list-disc"}`}/>
  ),
  ol: ({ node: _n, ...p }) => <ol {...p} className="my-3 pl-6 space-y-1 list-decimal [&_ul]:my-1 [&_ol]:my-1"/>,
  li: ({ node: _n, ...p }) => <li {...p} className="pl-0.5 marker:text-gray-400 dark:marker:text-white/35"/>,
  input: ({ node: _n, ...p }) => <input {...p} className="mr-2 align-middle accent-blue-600" />,
  blockquote: ({ node: _n, ...p }) => (
    <blockquote {...p} className="my-4 pl-4 border-l-4 border-gray-300 dark:border-white/15 text-gray-500 dark:text-white/55"/>
  ),
  hr: () => <hr className="my-8 border-0 h-px bg-gray-200 dark:bg-white/10" />,
  table: ({ node: _n, ...p }) => (
    <div className="my-4 overflow-x-auto">
      <table {...p} className="border-collapse text-[0.92em]"/>
    </div>
  ),
  th: ({ node: _n, ...p }) => (
    <th {...p} className="px-3 py-1.5 text-left font-semibold border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/4"/>
  ),
  td: ({ node: _n, ...p }) => <td {...p} className="px-3 py-1.5 align-top border border-gray-200 dark:border-white/10"/>,
  kbd: ({ node: _n, ...p }) => (
    <kbd {...p}
      className="px-1.5 py-px mx-0.5 rounded-md text-[0.8em] border border-b-2 border-gray-300 dark:border-white/20
        bg-gray-50 dark:bg-white/6 text-gray-700 dark:text-white/80"
      style={{ fontFamily: TERMINAL_FONT }}/>
  ),
  details: ({ node: _n, ...p }) => <details {...p} className="my-3 [&>summary]:cursor-pointer [&>summary]:font-medium"/>,
  del: ({ node: _n, ...p }) => <del {...p} className="text-gray-500 dark:text-white/45"/>,
};
