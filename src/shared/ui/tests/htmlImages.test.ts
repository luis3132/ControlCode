import { describe, expect, it } from "vitest";

import { htmlImagesToMarkdown } from "../htmlImages";

describe("htmlImagesToMarkdown", () => {
  it("pasa la etiqueta que deja GitHub al arrastrar una captura", () => {
    const html = 'Mirá:\n<img width="759" height="183" alt="Image" src="https://github.com/user-attachments/assets/abc" />\nfin';
    expect(htmlImagesToMarkdown(html)).toBe("Mirá:\n![Image](<https://github.com/user-attachments/assets/abc>)\nfin");
  });

  it("acepta comillas simples, sin comillas y entidades", () => {
    expect(htmlImagesToMarkdown("<img src='a.png?x=1&amp;y=2'>")).toBe("![](<a.png?x=1&y=2>)");
    expect(htmlImagesToMarkdown("<IMG alt=logo SRC=b.png>")).toBe("![logo](<b.png>)");
  });

  it("no toca lo que no es una imagen ni una sin src", () => {
    expect(htmlImagesToMarkdown("<details><summary>x</summary></details>")).toBe("<details><summary>x</summary></details>");
    expect(htmlImagesToMarkdown("<img alt=x>")).toBe("<img alt=x>");
    expect(htmlImagesToMarkdown("un `<imgx>` suelto")).toBe("un `<imgx>` suelto");
    expect(htmlImagesToMarkdown("`<img src=a>` y ```\n<img src=b>\n```")).toBe("`<img src=a>` y ```\n<img src=b>\n```");
  });
});
