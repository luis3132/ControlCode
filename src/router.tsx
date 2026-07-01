import { createHashRouter } from "react-router-dom";
import { AppShell } from "./layouts/AppShell";
import { HomePage } from "./pages/HomePage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkspacesPage } from "./pages/WorkspacesPage";
import { SkillsPage } from "./pages/SkillsPage";
import { SkillDetailPage } from "./pages/SkillDetailPage";
import { SessionsPage } from "./pages/SessionsPage";

export const router = createHashRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "workspace", element: <></> },
      { path: "workspaces", element: <WorkspacesPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "skills", element: <SkillsPage /> },
      { path: "skills/:id", element: <SkillDetailPage /> },
      { path: "sessions", element: <SessionsPage /> },
    ],
  },
]);
