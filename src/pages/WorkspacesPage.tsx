import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button, Input } from "neogestify-ui-components";
import { EditIcon, TrashIcon, CheckIcon, CancelIcon, BackIcon } from "neogestify-ui-components";
import { useWorkspacesStore, WorkspaceSummary } from "../store/workspaces";
import { OpenWorkspaceDialog } from "../components/workspace/OpenWorkspaceDialog";

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

export function WorkspacesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { workspaces, loadWorkspaces, renameWorkspace, deleteWorkspace } = useWorkspacesStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [openTarget, setOpenTarget] = useState<WorkspaceSummary | null>(null);

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  const startEdit = (ws: WorkspaceSummary) => {
    setEditingId(ws.id);
    setEditingName(ws.name);
    setError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingName("");
  };

  const confirmEdit = async (id: string) => {
    const trimmed = editingName.trim();
    if (!trimmed) return;
    try {
      await renameWorkspace(id, trimmed);
      setEditingId(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDelete = async (ws: WorkspaceSummary) => {
    try {
      await deleteWorkspace(ws.id);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <main className="min-h-full px-6 py-10 bg-gray-50 dark:bg-gray-950">
      <div className="max-w-2xl mx-auto">

        <div className="flex items-center gap-3 mb-10">
          <Button variant="icon" onClick={() => navigate("/")} title={t("btn.back")}>
            <BackIcon className="w-4 h-4" />
          </Button>
          <div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
              {t("workspace.manage.title")}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t("workspace.manage.subtitle")}
            </p>
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-500 dark:text-red-400 mb-4">{error}</p>
        )}

        {workspaces.length === 0 ? (
          <p className="text-sm italic text-gray-400 dark:text-gray-500">
            {t("home.recent.empty")}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {workspaces.map((ws) => (
              <div
                key={ws.id}
                className="flex items-center justify-between gap-3 px-4 py-3
                  rounded-lg border border-gray-200 dark:border-gray-700
                  bg-white dark:bg-gray-800/50
                  hover:border-gray-300 dark:hover:border-gray-600
                  transition-colors"
              >
                {editingId === ws.id ? (
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <Input
                      autoFocus
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") confirmEdit(ws.id);
                        if (e.key === "Escape") cancelEdit();
                      }}
                      variant="outline"
                      className="flex-1"
                    />
                    <Button variant="icon" onClick={() => confirmEdit(ws.id)} title={t("btn.save")}>
                      <CheckIcon className="w-4 h-4 text-green-600" />
                    </Button>
                    <Button variant="icon" onClick={cancelEdit} title={t("btn.cancel")}>
                      <CancelIcon className="w-4 h-4" />
                    </Button>
                  </div>
                ) : (
                  <>
                    <button
                      onClick={() => setOpenTarget(ws)}
                      className="flex flex-col min-w-0 text-left flex-1"
                    >
                      <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">
                        {ws.name}
                      </span>
                      <span className="text-xs text-gray-400 dark:text-gray-500 truncate">
                        {t("workspace.list.summary", { windows: ws.windowCount, tabs: ws.tabCount })}
                        {" · "}
                        {formatRelative(ws.lastActive, t)}
                      </span>
                    </button>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button variant="icon" onClick={() => startEdit(ws)} title={t("workspace.manage.rename")}>
                        <EditIcon className="w-4 h-4" />
                      </Button>
                      <Button variant="danger" onClick={() => handleDelete(ws)} title={t("workspace.manage.delete")}>
                        <TrashIcon className="w-4 h-4" />
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

      </div>

      {openTarget && (
        <OpenWorkspaceDialog workspace={openTarget} onClose={() => setOpenTarget(null)} />
      )}
    </main>
  );
}
