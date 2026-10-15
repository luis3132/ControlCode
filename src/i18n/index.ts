import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import es from "@/i18n/locales/es.json";
import en from "@/i18n/locales/en.json";
import pt from "@/i18n/locales/pt.json";
import fr from "@/i18n/locales/fr.json";
import de from "@/i18n/locales/de.json";
import it from "@/i18n/locales/it.json";

i18n.use(initReactI18next).init({
  resources: {
    es: { translation: es },
    en: { translation: en },
    pt: { translation: pt },
    fr: { translation: fr },
    de: { translation: de },
    it: { translation: it },
  },
  lng: localStorage.getItem("language") ?? "es",
  fallbackLng: "es",
  interpolation: { escapeValue: false },
});

export default i18n;
