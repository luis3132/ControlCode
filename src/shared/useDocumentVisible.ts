import { useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};
const visibleNow = () => document.visibilityState !== "hidden";

/** Si la ventana se ve: `false` minimizada, en otro escritorio o tapada del todo (según el
 *  sistema). Es lo que pausa el trabajo de fondo de lo que nadie puede estar mirando. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribe, visibleNow, () => true);
}
