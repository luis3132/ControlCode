/**
 * Mantiene la raíz de la ventana quieta en (0, 0).
 *
 * La app nunca desplaza el documento: cada panel scrollea por dentro. Pero el viewport (y
 * cualquier contenedor con `overflow: hidden`) se puede desplazar igual, sin barra para
 * volver: lo hace el navegador al llevar a la vista un input enfocado, o al arrastrar una
 * selección. En Wayland una ventana nueva nace chica y crece después, y lo desplazado al
 * nacer quedaba: la app se veía corrida, con medio botón de ventana afuera y el resto
 * transparente. `overflow: clip` lo evita en los contenedores, pero en la raíz el
 * navegador lo trata como `hidden`, así que se corrige acá.
 */
export function installRootScrollPin(): () => void {
  const isRoot = (el: EventTarget | null): el is Element =>
    el instanceof Element &&
    (el === document.documentElement || el === document.body || el.id === "root" || el.classList.contains("cc-clip"));

  const reset = (el: Element) => {
    if (el.scrollTop !== 0) el.scrollTop = 0;
    if (el.scrollLeft !== 0) el.scrollLeft = 0;
  };

  const resetAll = () => {
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    reset(document.documentElement);
    reset(document.body);
    const root = document.getElementById("root");
    if (root) reset(root);
    document.querySelectorAll(".cc-clip").forEach(reset);
  };

  const onScroll = (e: Event) => {
    if (e.target === document || e.target === window) resetAll();
    else if (isRoot(e.target)) reset(e.target);
  };

  // En captura: el `scroll` de un elemento no burbujea.
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  window.addEventListener("resize", resetAll);
  resetAll();
  return () => {
    document.removeEventListener("scroll", onScroll, { capture: true });
    window.removeEventListener("resize", resetAll);
  };
}
