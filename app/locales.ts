import type { ResourceLanguage } from "i18next";
import es from "../public/locales/es/translation.json";
import en from "../public/locales/en/translation.json";
import pt from "../public/locales/pt/translation.json";
import fr from "../public/locales/fr/translation.json";
import de from "../public/locales/de/translation.json";
import it from "../public/locales/it/translation.json";

export const resources = {
  es: { translation: es } satisfies ResourceLanguage,
  en: { translation: en } satisfies ResourceLanguage,
  pt: { translation: pt } satisfies ResourceLanguage,
  fr: { translation: fr } satisfies ResourceLanguage,
  de: { translation: de } satisfies ResourceLanguage,
  it: { translation: it } satisfies ResourceLanguage,
};
