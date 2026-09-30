/* Import Pilot — Service Worker de mantenimiento
 * Intercepta solo navegaciones (GET + mode navigate).
 * Si el origen falla (red caída, 5xx, 404 "página del tren" de Railway)
 * sirve una pantalla propia de mantenimiento con auto-recarga cada 5s.
 * En cuanto el origen responde 200/302, la recarga carga la app real.
 */

const RAILWAY_PAGE = /train has not arrived|Go to Railway|Please check your network settings to confirm that your domain/i;

const M = {
  es: {
    title: "Mantenimiento",
    msg: "La aplicación se está restaurando. Esta página se actualizará automáticamente en unos segundos, no es necesario hacer nada.",
    reconnecting: "Reconectando…",
    last: "Último intento",
    name: "Import Pilot",
  },
  en: {
    title: "Maintenance",
    msg: "The application is being restored. This page will refresh automatically in a few seconds — there is nothing you need to do.",
    reconnecting: "Reconnecting…",
    last: "Last attempt",
    name: "Import Pilot",
  },
  pt: {
    title: "Manutenção",
    msg: "A aplicação está sendo restaurada. Esta página será atualizada automaticamente em alguns segundos — não é necessário fazer nada.",
    reconnecting: "Reconectando…",
    last: "Última tentativa",
    name: "Import Pilot",
  },
  de: {
    title: "Wartung",
    msg: "Die Anwendung wird wiederhergestellt. Diese Seite wird in wenigen Sekunden automatisch aktualisiert — Sie müssen nichts tun.",
    reconnecting: "Neuverbindung wird hergestellt…",
    last: "Letzter Versuch",
    name: "Import Pilot",
  },
  fr: {
    title: "Maintenance",
    msg: "L'application est en cours de restauration. Cette page se rafraîchira automatiquement dans quelques secondes — rien à faire de votre côté.",
    reconnecting: "Reconnexion…",
    last: "Dernière tentative",
    name: "Import Pilot",
  },
  it: {
    title: "Manutenzione",
    msg: "L'applicazione è in fase di ripristino. Questa pagina si aggiornerà automaticamente tra pochi secondi — non è necessario fare nulla.",
    reconnecting: "Riconnessione…",
    last: "Ultimo tentativo",
    name: "Import Pilot",
  },
};

function detectLang(req) {
  try {
    const loc = new URL(req.url).searchParams.get("locale");
    if (loc) {
      const base = loc.split("-")[0].toLowerCase();
      if (M[base]) return base;
    }
  } catch (e) {}
  const al = (req.headers.get("accept-language") || "").toLowerCase();
  for (const part of al.split(",")) {
    const code = part.split(";")[0].trim().slice(0, 2);
    if (M[code]) return code;
  }
  return "en";
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fallbackHtml(lang) {
  const t = M[lang] || M.en;
  return (
    '<!doctype html>' +
    '<html lang="' + lang + '">' +
    "<head>" +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta http-equiv="refresh" content="5">' +
    "<title>" + escapeHtml(t.title) + " · " + escapeHtml(t.name) + "</title>" +
    "<style>" +
    ":root{color-scheme:light}" +
    "*{box-sizing:border-box;margin:0;padding:0}" +
    "body{min-height:100vh;display:flex;align-items:center;justify-content:center;" +
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
    "background:linear-gradient(135deg,#f6f8fb 0%,#e8edf5 100%);color:#1a2233;padding:24px}" +
    ".card{background:#fff;border-radius:16px;box-shadow:0 8px 32px rgba(20,30,60,.10);" +
    "padding:40px 36px;max-width:440px;width:100%;text-align:center}" +
    ".spinner{width:44px;height:44px;margin:0 auto 22px;border:4px solid #dbe3f0;" +
    "border-top-color:#3b6ef5;border-radius:50%;animation:spin .9s linear infinite}" +
    "@keyframes spin{to{transform:rotate(360deg)}}" +
    "h1{font-size:20px;font-weight:650;margin-bottom:10px;letter-spacing:.2px}" +
    "p{font-size:14.5px;line-height:1.55;color:#55617a}" +
    ".status{margin-top:22px;font-size:13px;color:#3b6ef5;font-weight:600}" +
    ".time{margin-top:8px;font-size:12px;color:#93a0b8}" +
    ".brand{margin-top:26px;font-size:12px;color:#a7b1c4;letter-spacing:.4px}" +
    "</style>" +
    "</head>" +
    "<body>" +
    '<main class="card">' +
    '<div class="spinner" aria-hidden="true"></div>' +
    "<h1>" + escapeHtml(t.title) + "</h1>" +
    "<p>" + escapeHtml(t.msg) + "</p>" +
    '<div class="status">' + escapeHtml(t.reconnecting) + "</div>" +
    '<div class="time">' + escapeHtml(t.last) + ': <span id="clock"></span></div>' +
    '<div class="brand">' + escapeHtml(t.name) + "</div>" +
    "</main>" +
    "<script>" +
    "(function(){" +
    "try{document.getElementById('clock').textContent=new Date().toLocaleTimeString();}catch(e){}" +
    "try{" +
    "var p=new URLSearchParams(location.search);" +
    "if(p.get('ip_sw_test')==='fallback'){" +
    "var k='ip_sw_fallback_n';" +
    "var n=parseInt(sessionStorage.getItem(k)||'0',10)+1;" +
    "sessionStorage.setItem(k,String(n));" +
    "if(n>=3){sessionStorage.removeItem(k);p.delete('ip_sw_test');" +
    "var qs=p.toString();" +
    "setTimeout(function(){location.replace(location.pathname+(qs?'?'+qs:'')+location.hash);},1200);}" +
    "}" +
    "}catch(e){}" +
    "setTimeout(function(){location.reload();},5000);" +
    "})();" +
    "</script>" +
    "</body>" +
    "</html>"
  );
}

function fallbackResponse(req) {
  return new Response(fallbackHtml(detectLang(req)), {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}

async function handleNavigation(req) {
  if (req.method !== "GET" || req.mode !== "navigate") return fetch(req);
  try {
    const url = new URL(req.url);
    if (url.searchParams.get("ip_sw_test") === "fallback") return fallbackResponse(req);
  } catch (e) {}
  try {
    const res = await fetch(req);
    if (res.status >= 500) return fallbackResponse(req);
    if (res.status === 404) {
      const ct = res.headers.get("content-type") || "";
      if (ct.indexOf("text/html") !== -1) {
        const body = await res.clone().text().catch(() => "");
        if (RAILWAY_PAGE.test(body)) return fallbackResponse(req);
      }
    }
    return res;
  } catch (e) {
    return fallbackResponse(req);
  }
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  event.respondWith(handleNavigation(req));
});
