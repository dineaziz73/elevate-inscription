// Vercel Serverless Function — GET /api/go
// Lien à utiliser dans les emails Systeme.io :
//   https://elevate-inscription.vercel.app/api/go?to=video&src=e01&e={email}
//   https://elevate-inscription.vercel.app/api/go?to=rdv&src=e06&e={email}
//
// Retrouve le contact Systeme.io à partir de son email, crée le jeton signé
// et redirige vers la page demandée avec ?t=<jeton>. L'email ne transite jamais
// par une page qui contient le pixel Meta (redirection côté serveur).
// En cas de souci (contact introuvable, API indisponible), la personne est
// quand même redirigée vers la bonne page, simplement sans suivi Systeme.io.
//
// Variables d'environnement : SYSTEMEIO_API_KEY (obligatoire), TRACK_SECRET (optionnel),
// GO_VIDEO_URL et GO_RDV_URL (optionnels).

const crypto = require("crypto");
const API = "https://api.systeme.io/api";

const DEST = {
  video: process.env.GO_VIDEO_URL || "https://systeme.elevatelifinsy.com/visionnage",
  rdv: process.env.GO_RDV_URL || "https://systeme.elevatelifinsy.com/appel",
};

function secret() {
  return process.env.TRACK_SECRET || crypto.createHash("sha256").update("elv:" + process.env.SYSTEMEIO_API_KEY).digest("hex");
}

function signToken(cid) {
  const sig = crypto.createHmac("sha256", secret()).update(String(cid)).digest("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 22);
  return cid + "." + sig;
}

async function findContactId(email) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const r = await fetch(API + "/contacts?email=" + encodeURIComponent(email) + "&limit=10", {
      headers: { "X-API-Key": process.env.SYSTEMEIO_API_KEY, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const data = await r.json();
    const items = (data && (data.items || data["hydra:member"])) || [];
    const c = items.find((x) => (x.email || "").toLowerCase() === email);
    return c ? c.id : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  const q = req.query || {};
  const to = DEST[String(q.to || "video")] ? String(q.to || "video") : "video";
  const src = String(q.src || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 30);
  // Dans une URL, un « + » d'adresse email peut arriver transformé en espace
  const email = String(q.e || "").trim().toLowerCase().replace(/ /g, "+");

  const url = new URL(DEST[to]);
  url.searchParams.set("utm_source", "email");
  url.searchParams.set("utm_medium", "sequence");
  if (src) url.searchParams.set("utm_content", src);

  if (process.env.SYSTEMEIO_API_KEY && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    const cid = await findContactId(email);
    if (cid) url.searchParams.set("t", signToken(cid));
  }

  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.statusCode = 302;
  res.setHeader("Location", url.toString());
  res.end();
};
