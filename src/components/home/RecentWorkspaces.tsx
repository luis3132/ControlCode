import { useTranslation } from "react-i18next";

export interface RecentWorkspace {
  id: string;
  name: string;
  rootPath: string;
  lastActive: number;
}

interface RecentWorkspacesProps {
  workspaces: RecentWorkspace[];
  onSelect: (rootPath: string) => void;
}

function formatRelative(unixSeconds: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const diffSeconds = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  const units: [number, string][] = [
    [60, "s"], [60, "m"], [24, "h"], [30, "d"], [12, "mo"], [Infinity, "y"],
  ];
  let value = diffSeconds;
  let unit = "s";
  for (const [size, label] of units) {
    if (value < size) { unit = label; break; }
    value = Math.floor(value / size);
    unit = label;
  }
  return t("home.recent.lastActive", { time: `${value}${unit}` });
}

export function RecentWorkspaces({ workspaces, onSelect }: RecentWorkspacesProps) {
  const { t } = useTranslation();

  if (workspaces.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <span className="text-[11px] font-semibold uppercase tracking-widest
        text-gray-400 dark:text-gray-500">
        {t("home.recent.title")}
      </span>

      <div className="flex flex-col gap-1.5">
        {workspaces.map((ws) => (
          <button
            key={ws.id}
            onClick={() => onSelect(ws.rootPath)}
            title={ws.rootPath}
            className="flex items-center justify-between gap-3 px-3 py-2 rounded-sm border text-left
              border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/60
              hover:border-gray-300 dark:hover:border-gray-600 hover:shadow-sm
              transition-all duration-150"
          >
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">
                {ws.name}
              </span>
              <span className="text-xs font-mono text-gray-400 dark:text-gray-500 truncate">
                {ws.rootPath}
              </span>
            </div>
            <span className="text-[11px] text-gray-400 dark:text-gray-500 shrink-0">
              {formatRelative(ws.lastActive, t)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
