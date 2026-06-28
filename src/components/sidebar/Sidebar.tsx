import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  HomeIcon,
  ClockIcon,
  StackIcon,
  CloudIcon,
  GearIcon,
  MenuIcon,
} from "neogestify-ui-components";
import { useTabsStore } from "../../store/tabs";

export function Sidebar() {
  const { t } = useTranslation();
  const { sidebarCollapsed, toggleSidebar } = useTabsStore();
  const navigate = useNavigate();
  const location = useLocation();

  const ITEMS = [
    { id: "home",         Icon: HomeIcon,  labelKey: "sidebar.home",         path: "/"         },
    { id: "sessions",     Icon: ClockIcon, labelKey: "sidebar.sessions",     path: null         },
    { id: "skills",       Icon: StackIcon, labelKey: "sidebar.skills",       path: null         },
    { id: "marketplace",  Icon: CloudIcon, labelKey: "sidebar.marketplace",  path: null         },
    { id: "settings",     Icon: GearIcon,  labelKey: "sidebar.settings",     path: "/settings"  },
  ] as const;

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
      <button
        onClick={toggleSidebar}
        title={sidebarCollapsed ? t("sidebar.expand") : t("sidebar.collapse")}
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
        {ITEMS.map(({ id, Icon, labelKey, path }) => {
          const isActive = path !== null && location.pathname === path;
          const isDisabled = path === null;
          const label = t(labelKey);
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
