// Vercel Serverless Function — POST /api/track
// Reçoit les étapes de la page vidéo (/visionnage) et pose les tags correspondants dans Systeme.io.
// Le contact est identifié par un jeton signé (paramètre ?t= ajouté par /api/subscribe),
// jamais par son email en clair dans l'URL.
//
// Corps (JSON, envoyé en text/plain via sendBeacon ou fetch) :
//   { t: "<jeton>", event: "visit|start|p25|p50|p75|complete|click|booked|whoami", event_id?: "..." }
//
// Variables d'environnement utilisées : SYSTEMEIO_API_KEY (obligatoire),
// TRACK_SECRET (optionnel), META_PIXEL_ID + META_CAPI_TOKEN (optionnels, pour l'événement Schedule côté serveur),
// ALLOWED_ORIGINS (optionnel, défaut : https://systeme.elevatelifinsy.com)

const crypto = require("crypto");
const API = "https://api.systeme.io/api";

const TAGS = {
  visit: "ELEVATE - Page vidéo visitée",
  start: "ELEVATE - Vidéo démarrée",
  p25: "ELEVATE - Vidéo 25%",
  p50: "ELEVATE - Vidéo 50%",
  p75: "ELEVATE - Vidéo 75%",
  complete: "ELEVATE - Vidéo terminée",
  click: "ELEVATE - Clic RDV",
  booked: "ELEVATE - RDV réservé",
};

const tagCache = {};

function secret() {
  return process.env.TRACK_SECRET || crypto.createHash("sha256").update("elv:" + process.env.SYSTEMEIO_API_KEY).digest("hex");
}

function verifyToken(t) {
  const m = /^(\d{1,15})\.([a-zA-Z0-9]{22})$/.exec(String(t || ""));
  if (!m) return null;
  const expected = crypto.createHmac("sha256", secret()).update(m[1]).digest("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 22);
  const a = Buffer.from(expected), b = Buffer.from(m[2]);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? m[1] : null;
}

function sio(path, { method = "GET", body } = {}) {
  const headers = { "X-API-Key": process.env.SYSTEMEIO_API_KEY, Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  return fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined }).then(async (r) => {
    let data = null;
    try { data = await r.json(); } catch (_) {}
    return { ok: r.ok, status: r.status, data };
  });
}

async function tagId(name) {
  if (tagCache[name]) return tagCache[name];
  const r = await sio("/tags?query=" + encodeURIComponent(name) + "&limit=100");
  const items = (r.data && (r.data.items || r.data["hydra:member"])) || [];
  let tag = items.find((x) => (x.name || "").trim().toLowerCase() === name.toLowerCase());
  if (!tag) {
    const c = await sio("/tags", { method: "POST", body: { name } });
    if (!c.ok) { console.error("Tag non créé", name, c.status, JSON.stringify(c.data)); return null; }
    tag = c.data;
  }
  tagCache[name] = tag.id;
  return tag.id;
}

function fieldValue(contact, slug) {
  const f = (contact.fields || []).find((x) => x.slug === slug);
  return f ? f.value : "";
}

function sha(v) { return crypto.createHash("sha256").update(String(v).trim().toLowerCase()).digest("hex"); }

async function capiSchedule(req, contact, p) {
  const pixel = process.env.META_PIXEL_ID, token = process.env.META_CAPI_TOKEN;
  if (!pixel || !token || !contact) return;
  const phone = String(fieldValue(contact, process.env.SYSTEMEIO_PHONE_SLUG || "phone_number") || "").replace(/\D/g, "");
  const fn = fieldValue(contact, "first_name");
  const user_data = {
    em: contact.email ? [sha(contact.email)] : undefined,
    ph: phone ? [sha(phone)] : undefined,
    fn: fn ? [sha(fn)] : undefined,
    external_id: [sha(contact.id)],
    client_ip_address: (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || undefined,
    client_user_agent: req.headers["user-agent"] || undefined,
    fbp: p.fbp || undefined,
    fbc: p.fbc || undefined,
  };
  try {
    await fetch(`https://graph.facebook.com/v21.0/${pixel}/events?access_token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [{
        event_name: "Schedule",
        event_time: Math.floor(Date.now() / 1000),
        event_id: p.event_id || undefined,
        action_source: "website",
        event_source_url: p.page_url || undefined,
        user_data,
        custom_data: { content_name: "Appel découverte ELEVATE" },
      }] }),
    });
  } catch (e) { console.error("CAPI Schedule", e); }
}

function cors(req, res) {
  const allowed = (process.env.ALLOWED_ORIGINS || "https://systeme.elevatelifinsy.com").split(",").map((s) => s.trim());
  const origin = req.headers.origin || "";
  if (allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
}

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST uniquement" });

  let p = req.body || {};
  if (typeof p === "string") { try { p = JSON.parse(p); } catch (_) { p = {}; } }
  if (Buffer.isBuffer(p)) { try { p = JSON.parse(p.toString("utf8")); } catch (_) { p = {}; } }

  const cid = verifyToken(p.t);
  if (!cid) return res.status(200).json({ ok: false, reason: "anonyme" });
  if (!process.env.SYSTEMEIO_API_KEY) return res.status(500).json({ ok: false });

  try {
    if (p.event === "whoami") {
      const c = await sio("/contacts/" + cid);
      if (!c.ok) return res.status(200).json({ ok: false });
      return res.status(200).json({ ok: true, first_name: fieldValue(c.data, "first_name") || "", email: c.data.email || "" });
    }

    const name = TAGS[p.event];
    if (!name) return res.status(400).json({ ok: false, reason: "événement inconnu" });
    const id = await tagId(name);
    if (id) {
      const r = await sio(`/contacts/${cid}/tags`, { method: "POST", body: { tagId: id } });
      if (!r.ok && r.status !== 422) console.warn("Tag", name, r.status, JSON.stringify(r.data));
    }

    if (p.event === "booked") {
      const c = await sio("/contacts/" + cid);
      if (c.ok) await capiSchedule(req, c.data, p);
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("track", e);
    return res.status(500).json({ ok: false });
  }
};
