/** La presentación entera como un PDF: una página por hoja, del tamaño de la hoja. */
import { PDFDocument } from "pdf-lib";

import { bytesToBase64, writeNewFile } from "@/features/diagram/files";

import { captureSlides, loadDeck } from "./store";

/** `docs/demo.slides` → `docs/demo.pdf`. */
export const deckPdfPath = (dir: string) => `${dir.replace(/\.slides[\\/]*$/i, "")}.pdf`;

export async function exportDeckPdf(dir: string, out = deckPdfPath(dir)): Promise<string> {
  const deck = await loadDeck(dir);
  const pages = await captureSlides(dir);
  const pdf = await PDFDocument.create();
  pdf.setTitle(deck.title);
  pdf.setCreator("Control Code");
  // 1 px = 0,75 pt: una hoja de 1920×1080 es una página de 1440×810 pt.
  const w = deck.size.w * 0.75;
  const h = deck.size.h * 0.75;
  for (const png of pages) {
    const image = await pdf.embedPng(png);
    pdf.addPage([w, h]).drawImage(image, { x: 0, y: 0, width: w, height: h });
  }
  await writeNewFile(out, { base64: bytesToBase64(await pdf.save()) });
  return out;
}
