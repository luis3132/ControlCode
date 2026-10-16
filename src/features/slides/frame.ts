import { useEffect, useRef, useState } from "react";

/** El tamaño de un elemento, al día. */
export function useBox<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setBox({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, box] as const;
}

/** Las hojas que van montadas: la actual y sus vecinas, para que pasar de una a otra no espere. */
export const mountedAround = (current: number, total: number) =>
  [current - 1, current, current + 1].filter((i) => i >= 0 && i < total);
