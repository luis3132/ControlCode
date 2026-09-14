/**
 * Lo que se dicen la tab del navegador y el selector que vive adentro de la página.
 *
 * Son dos orígenes distintos (la app y el proxy del proyecto), así que no hay otra forma
 * de hablar que `postMessage`. Los tipos viven acá y los usan las dos puntas: el selector
 * los importa como `import type`, que desaparece al compilarlo, así que sigue siendo un
 * script autocontenido.
 */

/** Firma de los mensajes que manda la página. Cualquier otro `postMessage` se ignora. */
export type PageSource = "controlcode-preview";
/** Firma de los mensajes que manda la app. */
export type AppSource = "controlcode";

export interface PickedComponent {
  framework: "React" | "Vue" | "Svelte";
  /** Nombre del componente, o `archivo:línea` en Svelte. */
  name: string;
}

/** Un elemento marcado, con lo que un agente necesita para encontrarlo en el código. */
export interface PickedElement {
  /** URL de la página tal como la ve el iframe (la del proxy). */
  url: string;
  title: string;
  selector: string;
  tag: string;
  text: string;
  html: string;
  attributes: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  component: PickedComponent | null;
}

export type PageMessage =
  | { source: PageSource; type: "nav"; payload: { url: string; title: string } }
  | { source: PageSource; type: "pick:selected"; payload: { element: PickedElement; keepPicking: boolean } }
  | { source: PageSource; type: "pick:cancel"; payload?: undefined };

export type AppMessage = {
  source: AppSource;
  type: "pick:on" | "pick:off" | "history:back" | "history:forward" | "hello";
};

export function isPageMessage(data: unknown): data is PageMessage {
  return typeof data === "object" && data !== null
    && (data as { source?: unknown }).source === ("controlcode-preview" satisfies PageSource);
}
