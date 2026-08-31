import { PassThrough } from "node:stream";
import type { AppLoadContext, EntryContext } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import type { RenderToPipeableStreamOptions } from "react-dom/server";
import { renderToPipeableStream } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import { resources } from "~/locales";
import { addDocumentResponseHeaders } from "~/shopify.server";
import { startScheduler } from "~/lib/scheduler.server";

startScheduler();

export const streamTimeout = 5_000;

function createServerI18n(locale: string) {
  const instance = i18next.createInstance();
  instance.init({
    resources,
    lng: locale,
    fallbackLng: "es",
    interpolation: { escapeValue: false },
  });
  return instance;
}

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: AppLoadContext,
) {
  addDocumentResponseHeaders(request, responseHeaders);

  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  const url = new URL(request.url);
  const shopifyLocale = url.searchParams.get("locale");
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookieLocale = cookieHeader.match(/(?:^|;\s*)shop_locale=([^;]*)/)?.[1];
  let locale = "en";

  if (shopifyLocale) {
    const map: Record<string, string> = {
      es: "es", "es-ES": "es",
      en: "en", "en-US": "en", "en-GB": "en",
      pt: "pt", "pt-BR": "pt",
      fr: "fr", de: "de", it: "it",
    };
    if (map[shopifyLocale]) locale = map[shopifyLocale];
    else {
      const base = shopifyLocale.split("-")[0];
      if (["es", "en", "pt", "fr", "de", "it"].includes(base)) locale = base;
    }
  } else if (cookieLocale && ["es", "en", "pt", "fr", "de", "it"].includes(cookieLocale)) {
    locale = cookieLocale;
  }

  return new Promise((resolve, reject) => {
    let shellRendered = false;
    let userAgent = request.headers.get("user-agent");

    let readyOption: keyof RenderToPipeableStreamOptions =
      (userAgent && isbot(userAgent)) || routerContext.isSpaMode
        ? "onAllReady"
        : "onShellReady";

    let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => abort(),
      streamTimeout + 1000,
    );

    const i18nInstance = createServerI18n(locale);

    const { pipe, abort } = renderToPipeableStream(
      <I18nextProvider i18n={i18nInstance}>
        <ServerRouter context={routerContext} url={request.url} />
      </I18nextProvider>,
      {
        [readyOption]() {
          shellRendered = true;
          const body = new PassThrough({
            final(callback) {
              clearTimeout(timeoutId);
              timeoutId = undefined;
              callback();
            },
          });
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");

          pipe(body);

          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          if (shellRendered) {
            console.error(error);
          }
        },
      },
    );
  });
}
