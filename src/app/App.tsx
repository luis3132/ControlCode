import { RouterProvider } from "react-router-dom";
import { router } from "@/app/router";
import "@/app/App.css";

export default function App() {
  return <RouterProvider router={router} />;
}
