/**
 * La rueda del mouse desplaza en horizontal las tiras que solo desbordan al costado (la
 * barra de tabs y las de cada grupo, todas `.cc-scroll-x`), sin tener que apretar Shift.
 *
 * Un solo listener delegado en el documento y no uno por tira: las tiras de los grupos
 * aparecen y desaparecen al dividir la pantalla, y así ninguna queda sin cubrir. Tiene que
 * ser nativo y no pasivo: el `onWheel` de React es pasivo y no puede frenar el scroll.
 */

/** Lo que importa de un `WheelEvent` para decidir. */
export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
}

/** Lo que importa de la tira. */
export interface StripLike {
  scrollWidth: number;
  clientWidth: number;
}

const LINE_PX = 16;

/**
 * Cuántos px correr la tira en horizontal por este giro, o `null` si no le toca a esta
 * función: un gesto que ya es horizontal (el trackpad lo resuelve solo), una tira que no
 * desborda, o un giro nulo.
 */
export function horizontalDelta(wheel: WheelLike, strip: StripLike): number | null {
  if (strip.scrollWidth <= strip.clientWidth) return null;
  if (wheel.deltaY === 0 || Math.abs(wheel.deltaX) >= Math.abs(wheel.deltaY)) return null;
  // deltaMode 1 = líneas (ruedas en Firefox/WebKitGTK con algunos ratones), 2 = páginas.
  const unit = wheel.deltaMode === 1 ? LINE_PX : wheel.deltaMode === 2 ? strip.clientWidth : 1;
  return wheel.deltaY * unit;
}

export function installWheelScrollX(root: Document = document) {
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey) return; // Ctrl+rueda es zoom.
    const strip = e.target instanceof Element ? e.target.closest<HTMLElement>(".cc-scroll-x") : null;
    if (!strip) return;
    const delta = horizontalDelta(e, strip);
    if (delta === null) return;
    e.preventDefault();
    strip.scrollLeft += delta;
  };
  root.addEventListener("wheel", onWheel, { passive: false });
  return () => root.removeEventListener("wheel", onWheel);
}
