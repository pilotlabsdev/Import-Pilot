import { startTransition, StrictMode } from "react";
import { HydratedRouter } from "react-router/dom";
import { hydrateRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { resources } from "~/locales";

const win = window as any;
win.__HYDRATION_ERRORS = [];
const originalError = window.console.error;
window.console.error = (...args: any[]) => {
  try {
    win.__HYDRATION_ERRORS.push(
      args.map((a) => (typeof a === "string" ? a : `${a}`)).join(" ").slice(0, 2000),
    );
  } catch {}
  originalError.apply(window.console, args);
};

const SUPPORTED = ["es", "en", "pt", "fr", "de", "it"];

function getClientLocale(): string {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const urlLocale = urlParams.get("locale");
    if (urlLocale) {
      const map: Record<string, string> = {
        es: "es", "es-ES": "es", en: "en", "en-US": "en", "en-GB": "en",
        pt: "pt", "pt-BR": "pt", fr: "fr", de: "de", it: "it",
      };
      if (map[urlLocale]) return map[urlLocale];
      const base = urlLocale.split("-")[0].toLowerCase();
      if (SUPPORTED.includes(base)) return base;
    }

    const cookieMatch = document.cookie.match(/(?:^|;\s*)shop_locale=([^;]*)/);
    const cookieLocale = cookieMatch?.[1];
    if (cookieLocale && SUPPORTED.includes(cookieLocale)) return cookieLocale;
  } catch {}

  return "en";
}

const detectedLng = getClientLocale();

i18next.use(initReactI18next).init({
  resources,
  lng: detectedLng,
  fallbackLng: "es",
  interpolation: { escapeValue: false },
});

startTransition(() => {
  hydrateRoot(
    document,
    <I18nextProvider i18n={i18next}>
      <StrictMode>
        <HydratedRouter />
      </StrictMode>
    </I18nextProvider>,
  );
});
