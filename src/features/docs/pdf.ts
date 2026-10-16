/**
 * Un documento Markdown como PDF, con texto de verdad (se selecciona y se busca), páginas
 * A4 y las imágenes del documento adentro.
 *
 * No pasa por el navegador ni por una captura: arma cada página con `pdf-lib` a partir del
 * árbol del Markdown (el mismo parser que usa la vista previa, con GFM). Así sale igual
 * cuando lo pide un agente con la ventana en otra cosa.
 *
 * Las fuentes son las estándar de PDF (Helvetica y Courier): no hay que llevar archivos de
 * fuente, a cambio de que lo que no está en su juego de caracteres (emojis, CJK) salga como
 * "?". El español, el portugués, el francés, el alemán y el italiano entran enteros.
 *
 * Puro salvo las imágenes, que las trae quien llama (`loadImage`): se prueba en Node.
 */
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type RGB } from "pdf-lib";
import type { Content, PhrasingContent, Root, RootContent, Table } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export interface PdfImage {
  bytes: Uint8Array;
  type: "png" | "jpg";
  /** Pixeles por pixel de pantalla: un SVG dibujado al doble para que se vea nítido es 2. */
  density?: number;
}

export interface PdfOptions {
  /** Trae una imagen por su `src` tal como está en el documento. `null` = no se pudo. */
  loadImage?: (src: string) => Promise<PdfImage | null>;
  title?: string;
}

const PAGE = { w: 595.28, h: 841.89 };
const MARGIN = { x: 56, top: 60, bottom: 60 };
const WIDTH = PAGE.w - 2 * MARGIN.x;
const BODY = 10.5;
const LEADING = 1.45;
const INK = rgb(0.12, 0.13, 0.16);
const MUTED = rgb(0.4, 0.42, 0.47);
const LINK = rgb(0.15, 0.39, 0.92);
const RULE = rgb(0.85, 0.86, 0.88);
const CODE_BG = rgb(0.96, 0.96, 0.97);
const HEADINGS = [0, 22, 17, 14, 12, 11, 10.5];

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
  mono: PDFFont;
}

/** Un tramo de texto con su estilo, como sale de aplanar el Markdown de un párrafo. */
interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: boolean;
  /** Una imagen en medio del texto se dibuja aparte, después del párrafo. */
  image?: string;
}

class Writer {
  pdf: PDFDocument;
  fonts: Fonts;
  page!: PDFPage;
  y = 0;
  private safeChars = new Map<string, string>();

  constructor(pdf: PDFDocument, fonts: Fonts) {
    this.pdf = pdf;
    this.fonts = fonts;
    this.newPage();
  }

  newPage() {
    this.page = this.pdf.addPage([PAGE.w, PAGE.h]);
    this.y = PAGE.h - MARGIN.top;
  }

  /** Que entren `h` puntos más en esta página; si no, a la siguiente. */
  need(h: number) {
    if (this.y - h < MARGIN.bottom) this.newPage();
  }

  /** El texto con lo que la fuente no sabe escribir cambiado por "?" (si no, pdf-lib tira). */
  safe(text: string, font: PDFFont): string {
    let out = "";
    for (const ch of text.replace(/\t/g, "    ")) {
      const key = `${font.name}:${ch}`;
      let ok = this.safeChars.get(key);
      if (ok === undefined) {
        try {
          font.widthOfTextAtSize(ch, 10);
          ok = ch;
        } catch {
          ok = ch === "‑" || ch === "‐" ? "-" : ch === " " ? " " : "?";
        }
        this.safeChars.set(key, ok);
      }
      out += ok;
    }
    return out;
  }

  fontOf(run: Run): PDFFont {
    if (run.code) return this.fonts.mono;
    if (run.bold && run.italic) return this.fonts.boldItalic;
    if (run.bold) return this.fonts.bold;
    if (run.italic) return this.fonts.italic;
    return this.fonts.regular;
  }

  /**
   * Escribe tramos de texto partidos en líneas de `width`, desde `x`. Devuelve las imágenes
   * que venían en medio, para dibujarlas después.
   */
  text(runs: Run[], opts: { x?: number; width?: number; size?: number; color?: RGB; force?: Partial<Run> } = {}): string[] {
    const x0 = opts.x ?? MARGIN.x;
    const width = opts.width ?? WIDTH;
    const size = opts.size ?? BODY;
    const lineH = size * LEADING;
    const images: string[] = [];

    // Palabras con su estilo; un espacio queda pegado al final de la palabra que lo sigue.
    const words: { text: string; run: Run }[] = [];
    for (const raw of runs) {
      if (raw.image) {
        images.push(raw.image);
        continue;
      }
      const run = { ...raw, ...opts.force };
      for (const piece of raw.text.split(/(\n)/)) {
        if (piece === "\n") {
          words.push({ text: "\n", run });
          continue;
        }
        for (const word of piece.split(/(?<=\s)/)) if (word) words.push({ text: word, run });
      }
    }

    let line: { text: string; run: Run; w: number }[] = [];
    let lineW = 0;
    const flush = () => {
      this.need(lineH);
      let x = x0;
      const baseline = this.y - size;
      for (const part of line) {
        const font = this.fontOf(part.run);
        const color = part.run.link ? LINK : opts.color ?? INK;
        if (part.run.code) {
          this.page.drawRectangle({ x: x - 1, y: baseline - 2.5, width: part.w + 2, height: size + 3, color: CODE_BG });
        }
        this.page.drawText(part.text, { x, y: baseline, size: part.run.code ? size * 0.92 : size, font, color });
        x += part.w;
      }
      this.y -= lineH;
      line = [];
      lineW = 0;
    };

    for (const word of words) {
      if (word.text === "\n") {
        flush();
        continue;
      }
      const font = this.fontOf(word.run);
      const text = this.safe(word.text, font);
      const fontSize = word.run.code ? size * 0.92 : size;
      let w = font.widthOfTextAtSize(text, fontSize);
      // Una palabra más ancha que la línea (una URL larga) se corta donde haga falta.
      if (w > width) {
        let rest = text;
        while (rest) {
          let cut = rest.length;
          while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), fontSize) > width - lineW) cut--;
          if (lineW > 0 && font.widthOfTextAtSize(rest.slice(0, cut), fontSize) > width - lineW) {
            flush();
            continue;
          }
          line.push({ text: rest.slice(0, cut), run: word.run, w: font.widthOfTextAtSize(rest.slice(0, cut), fontSize) });
          lineW += line[line.length - 1]!.w;
          rest = rest.slice(cut);
          if (rest) flush();
        }
        continue;
      }
      if (lineW + w > width && line.length > 0) {
        // El espacio del final no cuenta para el ancho de la línea.
        flush();
        const trimmed = text.replace(/^\s+/, "");
        w = font.widthOfTextAtSize(trimmed, fontSize);
        line.push({ text: trimmed, run: word.run, w });
        lineW = w;
        continue;
      }
      line.push({ text, run: word.run, w });
      lineW += w;
    }
    if (line.length > 0) flush();
    return images;
  }

  rule(x = MARGIN.x, width = WIDTH) {
    this.need(12);
    this.y -= 6;
    this.page.drawLine({ start: { x, y: this.y }, end: { x: x + width, y: this.y }, thickness: 0.7, color: RULE });
    this.y -= 6;
  }
}

/** El texto de un párrafo como tramos con estilo. */
function runsOf(nodes: PhrasingContent[], style: Partial<Run> = {}): Run[] {
  const out: Run[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out.push({ ...style, text: node.value });
        break;
      case "strong":
        out.push(...runsOf(node.children, { ...style, bold: true }));
        break;
      case "emphasis":
        out.push(...runsOf(node.children, { ...style, italic: true }));
        break;
      case "delete":
        out.push(...runsOf(node.children, style));
        break;
      case "inlineCode":
        out.push({ ...style, code: true, text: node.value });
        break;
      case "link":
        out.push(...runsOf(node.children, { ...style, link: true }));
        break;
      case "break":
        out.push({ ...style, text: "\n" });
        break;
      case "image":
        out.push({ text: "", image: node.url });
        break;
      case "html":
        // HTML suelto en un párrafo (`<br>`, `<kbd>`): se queda su texto.
        if (/^<br\s*\/?>$/i.test(node.value)) out.push({ ...style, text: "\n" });
        else out.push({ ...style, text: node.value.replace(/<[^>]+>/g, "") });
        break;
      default:
        if ("children" in node) out.push(...runsOf(node.children as PhrasingContent[], style));
        else if ("value" in node) out.push({ ...style, text: String(node.value) });
    }
  }
  return out;
}

async function drawImage(w: Writer, src: string, opts: PdfOptions, indent: number) {
  const loaded = await opts.loadImage?.(src).catch(() => null);
  if (!loaded) return;
  const image = loaded.type === "png" ? await w.pdf.embedPng(loaded.bytes) : await w.pdf.embedJpg(loaded.bytes);
  const maxW = WIDTH - indent;
  const maxH = (PAGE.h - MARGIN.top - MARGIN.bottom) * 0.7;
  // Las imágenes vienen en pixeles de pantalla; en el papel van a 0,75 pt por pixel, sin
  // agrandarlas, y achicadas si no entran.
  const density = loaded.density ?? 1;
  const cssW = image.width / density;
  const cssH = image.height / density;
  const scale = Math.min(0.75, maxW / cssW, maxH / cssH);
  const width = cssW * scale;
  const height = cssH * scale;
  w.need(height + 8);
  w.y -= 4;
  w.page.drawImage(image, { x: MARGIN.x + indent, y: w.y - height, width, height });
  w.y -= height + 8;
}

function drawCode(w: Writer, code: string, indent: number) {
  const size = 9;
  const lineH = size * 1.4;
  const x = MARGIN.x + indent;
  const width = WIDTH - indent;
  const font = w.fonts.mono;
  // Las líneas largas se cortan por caracteres: el código no se reacomoda por palabras.
  const charW = font.widthOfTextAtSize("M", size);
  const perLine = Math.max(10, Math.floor((width - 16) / charW));
  const lines = code.split("\n").flatMap((l) => {
    if (l.length <= perLine) return [l];
    const out: string[] = [];
    for (let i = 0; i < l.length; i += perLine) out.push(l.slice(i, i + perLine));
    return out;
  });
  w.y -= 4;
  let i = 0;
  while (i < lines.length) {
    w.need(lineH + 12);
    // Lo que entra en esta página, con su fondo.
    const room = Math.max(1, Math.floor((w.y - MARGIN.bottom - 12) / lineH));
    const chunk = lines.slice(i, i + room);
    const h = chunk.length * lineH + 12;
    w.page.drawRectangle({ x, y: w.y - h, width, height: h, color: CODE_BG, borderColor: RULE, borderWidth: 0.5 });
    let y = w.y - 6 - size;
    for (const line of chunk) {
      w.page.drawText(w.safe(line, font), { x: x + 8, y, size, font, color: INK });
      y -= lineH;
    }
    w.y -= h;
    i += chunk.length;
    if (i < lines.length) w.newPage();
  }
  w.y -= 8;
}

function drawTable(w: Writer, table: Table) {
  const columns = Math.max(...table.children.map((r) => r.children.length));
  if (columns === 0) return;
  const colW = WIDTH / columns;
  const size = 9.5;
  for (const [ri, row] of table.children.entries()) {
    const header = ri === 0;
    // Primero se mide cuánto alto necesita la fila (la celda más alta), escribiéndola en una
    // página de prueba; después se dibuja de verdad.
    const cells = row.children.map((cell) => runsOf(cell.children));
    const heights = cells.map((runs) => measure(w, runs, colW - 10, size, header));
    const h = Math.max(...heights, size * LEADING) + 8;
    w.need(h);
    const top = w.y;
    if (header) w.page.drawRectangle({ x: MARGIN.x, y: top - h, width: WIDTH, height: h, color: CODE_BG });
    for (let c = 0; c < columns; c++) {
      const x = MARGIN.x + c * colW;
      w.page.drawRectangle({ x, y: top - h, width: colW, height: h, borderColor: RULE, borderWidth: 0.6 });
      w.y = top - 4;
      w.text(cells[c] ?? [], { x: x + 5, width: colW - 10, size, force: header ? { bold: true } : {} });
    }
    w.y = top - h;
  }
  w.y -= 8;
}

/** Cuánto alto ocupan esos tramos en ese ancho, sin dibujarlos. */
function measure(w: Writer, runs: Run[], width: number, size: number, bold: boolean): number {
  const lineH = size * LEADING;
  let lines = 1;
  let lineW = 0;
  for (const run of runs) {
    const font = bold ? w.fonts.bold : w.fontOf(run);
    for (const word of run.text.split(/(?<=\s)/)) {
      if (word === "\n") {
        lines++;
        lineW = 0;
        continue;
      }
      const ww = font.widthOfTextAtSize(w.safe(word, font), size);
      if (lineW + ww > width && lineW > 0) {
        lines += Math.max(1, Math.ceil(ww / width));
        lineW = ww % width;
      } else lineW += ww;
    }
  }
  return lines * lineH;
}

async function drawBlocks(w: Writer, nodes: (RootContent | Content)[], opts: PdfOptions, indent = 0, quoted = false) {
  for (const node of nodes) {
    const x = MARGIN.x + indent;
    const width = WIDTH - indent;
    const color = quoted ? MUTED : INK;
    switch (node.type) {
      case "heading": {
        const size = HEADINGS[node.depth] ?? BODY;
        w.need(size * 3);
        w.y -= node.depth <= 2 ? size * 0.8 : size * 0.5;
        w.text(runsOf(node.children), { x, width, size, color, force: { bold: true } });
        if (node.depth <= 2) w.rule(x, width);
        else w.y -= 2;
        break;
      }
      case "paragraph": {
        const images = w.text(runsOf(node.children), { x, width, color });
        for (const src of images) await drawImage(w, src, opts, indent);
        w.y -= BODY * 0.6;
        break;
      }
      case "list": {
        let n = node.start ?? 1;
        for (const item of node.children) {
          const marker = node.ordered ? `${n++}.` : item.checked === true ? "[x]" : item.checked === false ? "[ ]" : "•";
          w.need(BODY * LEADING);
          const markerY = w.y;
          const pageBefore = w.page;
          // El contenido del ítem, corrido a la derecha de la viñeta.
          await drawBlocks(w, item.children, opts, indent + 16, quoted);
          pageBefore.drawText(w.safe(marker, w.fonts.regular), { x: x + 2, y: markerY - BODY, size: BODY, font: w.fonts.regular, color });
          w.y += BODY * 0.35;
        }
        w.y -= BODY * 0.4;
        break;
      }
      case "code":
        drawCode(w, node.value, indent);
        break;
      case "blockquote": {
        const startPage = w.page;
        const startY = w.y;
        await drawBlocks(w, node.children, opts, indent + 14, true);
        // La barra de la izquierda, en la página donde empezó (una cita que cruza de página
        // la lleva solo en la primera: alcanza para leerla como cita).
        const endY = w.page === startPage ? w.y + BODY * 0.4 : MARGIN.bottom;
        startPage.drawRectangle({ x: x + 2, y: endY, width: 2.5, height: startY - endY, color: RULE });
        break;
      }
      case "thematicBreak":
        w.rule(x, width);
        break;
      case "table":
        drawTable(w, node);
        break;
      case "html": {
        const text = node.value.replace(/<[^>]+>/g, "").trim();
        if (text) w.text([{ text }], { x, width, color });
        break;
      }
      default:
        if ("children" in node) await drawBlocks(w, node.children as Content[], opts, indent, quoted);
    }
  }
}

/** El primer título del documento, para los metadatos del PDF. */
export function titleOf(markdown: string): string | null {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match ? match[1]!.trim() : null;
}

export async function markdownToPdf(markdown: string, opts: PdfOptions = {}): Promise<Uint8Array> {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;
  const pdf = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await pdf.embedFont(StandardFonts.Courier),
  };
  const title = opts.title ?? titleOf(markdown);
  if (title) pdf.setTitle(title);
  pdf.setCreator("Control Code");
  const writer = new Writer(pdf, fonts);
  await drawBlocks(writer, tree.children, opts);
  return pdf.save();
}
