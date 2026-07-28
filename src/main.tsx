import "./i18n/index";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "neogestify-ui-components";
import App from "./App";

// El tema inicial (default "dark") ya lo resolvió y persistió el script inline de
// index.html, que corre antes del primer pintado — repetirlo aquí llegaría tarde.

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
);
