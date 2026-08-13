import { useEffect, useState } from "react";

export interface SettingsSectionRef {
  id: string;
  label: string;
}

interface SettingsNavProps {
  sections: SettingsSectionRef[];
  title: string;
}

/**
 * Índice de las secciones de Configuración, fijo a la izquierda.
 *
 * La página creció hasta no entrar en una pantalla, y sin índice la única forma de saber
 * qué hay es scrollear hasta el final. Un índice resuelve las dos cosas de una: muestra el
 * inventario completo de un vistazo y lleva a cualquier sección con un click.
 *
 * Se marca la sección visible en vez de solo listar: sin eso, después de scrollear un rato
 * el índice no dice dónde estás, que es la mitad de para qué sirve.
 */
export function SettingsNav({ sections, title }: SettingsNavProps) {
  const [active, setActive] = useState(sections[0]?.id ?? "");

  useEffect(() => {
    const nodes = sections
      .map((s) => document.getElementById(s.id))
      .filter((n): n is HTMLElement => n !== null);
    if (nodes.length === 0) return;

    // `rootMargin` recorta la ventana a una franja alta: la sección activa es la que cruza
    // la parte superior del área de lectura, no la que ocupa más pantalla. Con el criterio
    // de "la más visible", una sección corta entre dos largas nunca llegaría a marcarse.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-10% 0px -70% 0px", threshold: 0 }
    );

    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [sections]);

  return (
    <nav className="hidden lg:block w-52 shrink-0">
      <div className="sticky top-10 flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-widest
          text-gray-400 dark:text-gray-500 px-3 pb-1">
          {title}
        </span>

        {sections.map((section) => {
          const isActive = section.id === active;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() =>
                document.getElementById(section.id)?.scrollIntoView({
                  behavior: "smooth",
                  block: "start",
                })
              }
              className={`
                flex items-center gap-2 px-3 py-1.5 rounded-lg text-left text-xs
                transition-colors duration-150
                ${isActive
                  ? "bg-blue-500/10 text-blue-700 dark:bg-blue-400/10 dark:text-blue-300 font-semibold"
                  : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5 hover:text-gray-800 dark:hover:text-gray-200"}
              `}
            >
              {/* Barrita de posición: el color de fondo solo ya marca el activo, pero con
                  varias filas seguidas cuesta ubicarlo de reojo. */}
              <span className={`w-0.5 h-3.5 rounded-full shrink-0 transition-colors
                ${isActive ? "bg-blue-500" : "bg-transparent"}`} />
              <span className="truncate">{section.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
