import { createHashRouter } from "react-router-dom";
import { AppShell } from "./layouts/AppShell";
import { HomePage } from "./pages/HomePage";
import { SettingsPage } from "./pages/SettingsPage";

export const router = createHashRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "workspace", element: <></> },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
]);
