/**
 * El marco de una sección de Configuración.
 *
 * Antes cada sección repetía a mano la misma tarjeta con degradado, borde y sombra — la
 * cadena estaba copiada en cinco archivos, y cambiarla implicaba acordarse de los cinco.
 * Ahora el marco vive acá y las secciones solo traen su contenido.
 *
 * Y ya no es una tarjeta: Configuración se abre dentro de un modal que YA pone marco,
 * fondo y sombra. Poner otra tarjeta adentro era un recuadro dentro de un recuadro. Lo que
 * separa una sección de la siguiente es el título y el aire, como en el resto de la app.
 */
export function SettingsSection({ title, description, action, children }: {
  title: string;
  description?: string;
  /** Control que pertenece al encabezado y no al cuerpo (un botón de "agregar", un toggle). */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <h3 className="text-[13.5px] font-bold text-gray-900 dark:text-white">
            {title}
          </h3>
          {description && (
            <p className="text-[11.5px] leading-relaxed text-gray-500 dark:text-white/40">
              {description}
            </p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/** Una fila de ajuste: etiqueta a la izquierda, control a la derecha. */
export function SettingsRow({ label, hint, children }: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 h-9 px-3 rounded-lg
      bg-gray-100/70 dark:bg-white/4">
      <span className="flex flex-col gap-px min-w-0">
        <span className="truncate text-[12px] text-gray-700 dark:text-gray-300">{label}</span>
        {hint && (
          <span className="truncate text-[10.5px] text-gray-400 dark:text-white/30">{hint}</span>
        )}
      </span>
      <span className="shrink-0">{children}</span>
    </div>
  );
}
