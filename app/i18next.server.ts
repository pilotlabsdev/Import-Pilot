import { RemixI18Next } from "remix-i18next/server";
import i18n from "~/i18n";

const i18nServer = new RemixI18Next({
  detection: {
    supportedLanguages: i18n.supportedLngs,
    fallbackLanguage: i18n.fallbackLng,
  },
});

export default i18nServer;
