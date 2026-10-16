/**
 * Exportar un diagrama a un archivo: SVG (vectorial), PNG, PDF (una página del tamaño del
 * diagrama) o draw.io para seguir editándolo en diagrams.net.
 *
 * El PNG sale de dibujar el SVG en un `<canvas>` del webview, al doble de resolución; el PDF
 * lleva ese PNG adentro.
 */
import { PDFDocument } from "pdf-lib";

import { toDrawio } from "./drawio";
import { bytesToBase64, writeNewFile } from "./files";
import type { Diagram } from "./model";
import { toSvg } from "./svg";

export type ExportFormat = "png" | "svg" | "pdf" | "drawio";

export const EXPORT_FORMATS: ExportFormat[] = ["png", "svg", "pdf", "drawio"];

/** `docs/diagrams/arquitectura.diagram.json` → `docs/diagrams/arquitectura.png`. */
export function exportPath(path: string, format: ExportFormat): string {
  return `${path.replace(/\.diagram\.json$/i, "").replace(/\.json$/i, "")}.${format}`;
}

export async function svgToPng(svg: string, scale: number): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("No se pudo dibujar el diagrama"));
      image.src = url;
    });
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No hay canvas 2D para exportar");
    ctx.scale(scale, scale);
    ctx.drawImage(image, 0, 0, width, height);
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("No se pudo generar el PNG"))), "image/png")
    );
    return { bytes: new Uint8Array(await png.arrayBuffer()), width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Escribe el diagrama en ese formato y devuelve la ruta del archivo. */
export async function exportDiagram(diagram: Diagram, format: ExportFormat, out: string): Promise<string> {
  if (diagram.nodes.length === 0) throw new Error("El diagrama está vacío: no hay nada que exportar");
  switch (format) {
    case "svg":
      await writeNewFile(out, { text: toSvg(diagram) });
      break;
    case "drawio":
      await writeNewFile(out, { text: toDrawio(diagram) });
      break;
    case "png": {
      const { bytes } = await svgToPng(toSvg(diagram), 2);
      await writeNewFile(out, { base64: bytesToBase64(bytes) });
      break;
    }
    case "pdf": {
      const { bytes, width, height } = await svgToPng(toSvg(diagram), 3);
      const pdf = await PDFDocument.create();
      if (diagram.title) pdf.setTitle(diagram.title);
      pdf.setCreator("Control Code");
      // 1 px de pantalla = 0,75 pt de PDF: el diagrama sale del mismo tamaño que en pantalla.
      const page = pdf.addPage([width * 0.75, height * 0.75]);
      const image = await pdf.embedPng(bytes);
      page.drawImage(image, { x: 0, y: 0, width: width * 0.75, height: height * 0.75 });
      await writeNewFile(out, { base64: bytesToBase64(await pdf.save()) });
      break;
    }
  }
  return out;
}
