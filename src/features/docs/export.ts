/** Exportar un documento a PDF con sus imágenes (las del proyecto, incluidos los SVG de los
 *  diagramas). Ver `pdf.ts`. */
import { readFile } from "@/features/editor/ipc";
import { resolveDocPath } from "@/features/editor/markdown";
import { bytesToBase64, writeNewFile } from "@/features/diagram/files";
import { svgToPng } from "@/features/diagram/export";

import { markdownToPdf, type PdfImage } from "./pdf";
import { readDocText } from "./store";

const dataUrlBytes = (dataUrl: string) => Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0));

/** Una imagen que el PDF no sabe leer, redibujada como PNG. */
async function rasterize(dataUrl: string): Promise<Uint8Array> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("No se pudo leer la imagen"));
    image.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d")?.drawImage(image, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("No se pudo convertir la imagen"))), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Una imagen del documento, como la pide el PDF. Las remotas no se bajan. */
async function loadImage(docPath: string, root: string, src: string): Promise<PdfImage | null> {
  if (/^(https?:)?\/\//i.test(src) || src.startsWith("data:")) return null;
  const path = resolveDocPath(docPath, src.split(/[?#]/)[0]!, root);
  const file = await readFile(path);
  if (file.kind === "image") {
    if (/^data:image\/png/i.test(file.dataUrl)) return { bytes: dataUrlBytes(file.dataUrl), type: "png" };
    if (/^data:image\/jpe?g/i.test(file.dataUrl)) return { bytes: dataUrlBytes(file.dataUrl), type: "jpg" };
    // Otro formato (webp, gif): se pasa por el navegador a PNG.
    return { bytes: await rasterize(file.dataUrl), type: "png" };
  }
  if (file.kind === "text" && /\.svg$/i.test(path)) return { bytes: (await svgToPng(file.content, 2)).bytes, type: "png", density: 2 };
  return null;
}

/** `docs/informe.md` → `docs/informe.pdf`. */
export const docPdfPath = (path: string) => path.replace(/\.(md|markdown|mdx)$/i, "") + ".pdf";

export async function exportDocPdf(path: string, root: string, out = docPdfPath(path)): Promise<string> {
  const text = await readDocText(path);
  if (!text.trim()) throw new Error("El documento está vacío: no hay nada que exportar");
  const bytes = await markdownToPdf(text, { loadImage: (src) => loadImage(path, root, src) });
  await writeNewFile(out, { base64: bytesToBase64(bytes) });
  return out;
}
