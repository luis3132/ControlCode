/// <reference types="vite/client" />

/** Un `.ts` compilado a un script autocontenido, como string. Ver `scriptAsString` en
 *  vite.config.ts. */
declare module "*?script" {
  const source: string;
  export default source;
}
