import { ReactNode } from "react";

interface PageHeaderProps {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}

/** Encabezado estándar de las páginas de sección (Skills, Marketplace, Sesiones,
 * Workspaces, detalle de skill). Sin botón de "atrás": todas son alcanzables desde el
 * TopBar (nav o logo→Home), así que un back-button propio era una segunda forma de
 * navegar que además quedaba huérfana en páginas sin ícono en el TopBar. El ícono acá
 * es el mismo que identifica a la sección en el TopBar — ancla visual, no un botón. */
export function PageHeader({ icon, title, subtitle, action }: PageHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-3 mb-8">
      <div className="flex items-center gap-3 min-w-0">
        <span className="flex items-center justify-center w-10 h-10 rounded-xl shrink-0
          bg-linear-to-br from-blue-50 to-violet-50 dark:from-blue-500/10 dark:to-violet-500/10
          text-blue-600 dark:text-blue-400">
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white truncate">{title}</h2>
          {subtitle && (
            <p className="text-sm text-gray-500 dark:text-gray-400 truncate">{subtitle}</p>
          )}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
