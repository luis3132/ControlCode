import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vitest";

import { MARKDOWN_REHYPE, MARKDOWN_REMARK } from "../markdownPipeline";

const render = (markdown: string) =>
  renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: MARKDOWN_REMARK, rehypePlugins: MARKDOWN_REHYPE }, markdown),
  );

describe("pipeline de la vista previa", () => {
  it("interpreta el HTML de los README en vez de mostrarlo como texto", () => {
    const html = render('<div align="center">\n\n# Control Code\n\n<img src="logo.png" width="80">\n\n</div>');
    expect(html).toContain('<div align="center">');
    expect(html).toContain('<img src="logo.png" width="80"/>');
    expect(html).not.toContain("&lt;div");
  });

  it("deja details, summary y kbd", () => {
    const html = render("<details><summary>Más</summary>\n\nOculto con <kbd>Ctrl</kbd>\n\n</details>");
    expect(html).toContain("<details><summary>Más</summary>");
    expect(html).toContain("<kbd>Ctrl</kbd>");
  });

  it("saca lo que podría ejecutar algo", () => {
    const html = render(
      '<script>alert(1)</script>\n\n<img src="x.png" onerror="alert(1)">\n\n<iframe src="https://ejemplo.com"></iframe>\n\n' +
      '<a href="javascript:alert(1)">clic</a>\n\n<p style="position:fixed">tapa</p>',
    );
    expect(html).not.toMatch(/<script|onerror|<iframe|javascript:|style=/i);
  });

  it("los títulos llevan el id que usaría GitHub, sin prefijo", () => {
    const html = render("# Instalación rápida\n\n## Uso\n\n## Uso");
    expect(html).toContain('<h1 id="instalación-rápida">');
    expect(html).toContain('<h2 id="uso">');
    expect(html).toContain('<h2 id="uso-1">');
  });

  it("tablas, tareas y tachado de GFM", () => {
    const html = render("| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] hecha\n- [ ] pendiente\n\n~~viejo~~");
    expect(html).toContain("<table>");
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    expect(html).toContain("<del>viejo</del>");
  });

  it("el bloque de código conserva el lenguaje", () => {
    expect(render("```ts\nconst a = 1;\n```")).toContain('<code class="language-ts">');
  });
});
