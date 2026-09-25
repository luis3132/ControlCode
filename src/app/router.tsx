import { createHashRouter } from "react-router-dom";
import { AppShell } from "@/app/AppShell";
import { HomePage } from "@/features/workspaces/HomePage";
import { WorkspacesPage } from "@/features/workspaces/WorkspacesPage";
import { SkillsPage } from "@/features/skills/SkillsPage";
import { SkillDetailPage } from "@/features/skills/SkillDetailPage";
import { SessionsPage } from "@/features/sessions/SessionsPage";
import { FleetPage } from "@/features/runs/FleetPage";
import { MarketplacePage } from "@/features/marketplace/MarketplacePage";
import { RegistriesPage } from "@/features/marketplace/RegistriesPage";
import { ForgePage } from "@/features/forge/ForgePage";

export const router = createHashRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "workspace", element: <></> },
      { path: "workspaces", element: <WorkspacesPage /> },
      { path: "skills", element: <SkillsPage /> },
      { path: "skills/:id", element: <SkillDetailPage /> },
      { path: "sessions", element: <SessionsPage /> },
      { path: "fleet", element: <FleetPage /> },
      { path: "forge", element: <ForgePage /> },
      { path: "marketplace", element: <MarketplacePage /> },
      { path: "marketplace/registries", element: <RegistriesPage /> },
    ],
  },
]);
