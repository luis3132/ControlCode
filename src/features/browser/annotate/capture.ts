/**
 * Congelar la página: sacar la foto del webview (ver `src-tauri/src/preview/snapshot.rs`),
 * recortar lo que es la página, y después pasar lo anotado a PNG.
 */
import { previewCapture } from "../ipc";
import { cropFor, type Box, type Point, type Size } from "./geometry";

export interface FrozenPage {
  /** La página tal como se veía, en píxeles de la captura. */
  canvas: HTMLCanvasElement;
  /** Dónde estaba dentro de su columna, en px CSS. */
  offset: Point;
  /** Cuánto medía en pantalla, en px CSS. */
  screen: Size;
  /** Cuánto medía la columna. Si cambia, lo de abajo ya no es lo que estaba al lado de la
   *  foto, y el lienzo tiene que taparlo. */
  column: Size;
}

/** Un cuadro, o 50 ms si la ventana está oculta y no hay cuadros. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 50);
  });
}

const boxOf = (r: DOMRect): Box => ({ left: r.left, top: r.top, width: r.width, height: r.height });

async function decode(png: ArrayBuffer): Promise<CanvasImageSource & Size> {
  const blob = new Blob([png], { type: "image/png" });
  if (typeof createImageBitmap === "function") return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return Object.assign(image, { width: image.naturalWidth, height: image.naturalHeight });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * La página como se ve ahora. `page` es el iframe; `column`, lo que lo recorta.
 *
 * Espera dos cuadros antes de medir: lo que cambió al tocar el botón (el aviso de "marcar"
 * que se va, el selector que se apaga dentro de la página) tiene que haberse dibujado ya,
 * o saldría en la foto.
 */
export async function freezePage(page: HTMLElement, column: HTMLElement): Promise<FrozenPage> {
  await nextFrame();
  await nextFrame();
  const pageBox = boxOf(page.getBoundingClientRect());
  const columnBox = boxOf(column.getBoundingClientRect());
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const image = await decode(await previewCapture());
  const crop = cropFor(pageBox, columnBox, viewport, { width: image.width, height: image.height });
  if (!crop) throw new Error("la página no está a la vista");

  const canvas = document.createElement("canvas");
  canvas.width = crop.source.width;
  canvas.height = crop.source.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no hay canvas 2D");
  const { left, top, width, height } = crop.source;
  ctx.drawImage(image, left, top, width, height, 0, 0, width, height);
  if ("close" in image && typeof image.close === "function") image.close();
  return {
    canvas,
    offset: { x: crop.screen.left - columnBox.left, y: crop.screen.top - columnBox.top },
    screen: { width: crop.screen.width, height: crop.screen.height },
    column: { width: columnBox.width, height: columnBox.height },
  };
}

export async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("no se pudo generar la imagen");
  return new Uint8Array(await blob.arrayBuffer());
}

/** Una miniatura para mostrar en el mensaje antes de mandarlo. */
export function thumbnail(canvas: HTMLCanvasElement, maxWidth = 280): string {
  const scale = Math.min(1, maxWidth / canvas.width);
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.round(canvas.width * scale));
  small.height = Math.max(1, Math.round(canvas.height * scale));
  small.getContext("2d")?.drawImage(canvas, 0, 0, small.width, small.height);
  return small.toDataURL("image/jpeg", 0.8);
}
