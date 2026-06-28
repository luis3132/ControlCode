import { useNavigate, useLocation } from "react-router-dom";
import {
  HomeIcon,
  ClockIcon,
  StackIcon,
  CloudIcon,
  GearIcon,
  MenuIcon,
} from "neogestify-ui-components";
import { useTabsStore } from "../../store/tabs";

const ITEMS = [
  { id: "home",        Icon: HomeIcon,  label: "Home",        path: "/"         },
  { id: "sessions",   Icon: ClockIcon, label: "Sessions",    path: null         },
  { id: "skills",     Icon: StackIcon, label: "Skills",      path: null         },
  { id: "marketplace",Icon: CloudIcon, label: "Marketplace", path: null         },
  { id: "settings",   Icon: GearIcon,  label: "Settings",    path: "/settings"  },
] as const;

export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useTabsStore();
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <aside
      className={`
        flex flex-col shrink-0 border-r
        bg-white dark:bg-[#161b22]
        border-gray-200 dark:border-white/10
        transition-all duration-200
        ${sidebarCollapsed ? "w-12" : "w-44"}
      `}
    >
      {/* Toggle */}
      <button
        onClick={toggleSidebar}
        title={sidebarCollapsed ? "Expandir" : "Colapsar"}
        className="flex items-center justify-center h-10 w-full shrink-0
          text-gray-400 dark:text-white/40
          hover:text-gray-700 dark:hover:text-white/80
          hover:bg-gray-100 dark:hover:bg-white/5
          transition-colors"
      >
        <MenuIcon />
      </button>

      <div className="w-full h-px bg-gray-200 dark:bg-white/10 shrink-0" />

      <nav className="flex flex-col flex-1 py-2 gap-0.5">
        {ITEMS.map(({ id, Icon, label, path }) => {
          const isActive = path !== null && location.pathname === path;
          const isDisabled = path === null;
          return (
            <button
              key={id}
              title={label}
              disabled={isDisabled}
              onClick={() => path && navigate(path)}
              className={`
                flex items-center gap-3 px-3 py-2 rounded-md mx-1 transition-colors
                ${isActive
                  ? "bg-blue-50 dark:bg-white/10 text-blue-600 dark:text-white"
                  : isDisabled
                  ? "text-gray-300 dark:text-white/20 cursor-not-allowed"
                  : "text-gray-500 dark:text-white/40 hover:text-gray-800 dark:hover:text-white/80 hover:bg-gray-100 dark:hover:bg-white/5"}
              `}
            >
              <span className="shrink-0 w-5 h-5 flex items-center justify-center">
                <Icon />
              </span>
              {!sidebarCollapsed && (
                <span className="text-xs font-medium truncate">{label}</span>
              )}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
