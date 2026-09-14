/**
 * ¿Hay un diálogo abierto encima de todo?
 *
 * Los marcos que se cierran con Escape (`RouteModal`, `ShellModal`) escuchan en fase de
 * captura y cortan la propagación, para que el Escape no le llegue al agente de la terminal
 * de atrás. El problema es que eso los convierte en los PRIMEROS en enterarse — antes que el
 * diálogo que la librería monta encima (un `<dialog>` nativo, portaleado al `body`). Sin
 * este chequeo, un Escape en "Reglas de permisos" cerraba la consola entera, el diálogo se
 * iba con ella, y lo que se tipeaba después caía en la terminal.
 *
 * Con un diálogo abierto el Escape es suyo: el marco no hace nada y lo deja pasar. No hay
 * riesgo de que llegue a la terminal, porque un `<dialog>` modal tiene el foco adentro.
 */
export function hasOpenDialog(): boolean {
  return document.querySelector("dialog[open]") !== null;
}
