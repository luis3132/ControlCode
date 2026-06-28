import "./i18n/index";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "neogestify-ui-components";
import App from "./App";

// Dark por defecto en primera carga
if (!localStorage.getItem("theme")) {
  localStorage.setItem("theme", "dark");
  document.documentElement.classList.add("dark");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
);
