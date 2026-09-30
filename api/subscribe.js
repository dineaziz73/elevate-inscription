// Vercel Serverless Function — POST /api/subscribe
// 1) Crée (ou met à jour) le contact dans Systeme.io
// 2) Ajoute le tag qui déclenche l'automatisation (accès vidéo + relances)
// 3) (Optionnel) Envoie l'événement Lead à l'API Conversions de Meta
// 4) Renvoie l'URL de la page vidéo
//
// Variables d'environnement (Vercel → Settings → Environment Variables) :
//   SYSTEMEIO_API_KEY     (obligatoire)  Systeme.io → Profil → Clés API publiques
//   SYSTEMEIO_TAG_NAME    (optionnel)    nom du tag, défaut "ELEVATE - Optin video" (créé automatiquement)
//   SYSTEMEIO_TAG_ID      (optionnel)    ID du tag, prioritaire sur le nom
//   VIDEO_PAGE_URL        (obligatoire)  URL de la page vidéo Systeme.io
//   SYSTEMEIO_PHONE_SLUG  (optionnel)    slug du champ téléphone, défaut "phone_number"
//   META_PIXEL_ID         (optionnel)    pour l'API Conversions
//   META_CAPI_TOKEN       (optionnel)    jeton d'accès API Conversions

const crypto = require("crypto");

const API = "https://api.systeme.io/api";

function sio(path, { method = "GET", body, patch = false } = {}) {
  const headers = { "X-API-Key": process.env.SYSTEMEIO_API_KEY, Accept: "application/json" };
  if (body) headers["Content-Type"] = patch ? "application/merge-patch+json" : "application/json";
  return fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined }).then(async (r) => {
    let data = null;
    try { data = await r.json(); } catch (_) {}
    return { ok: r.ok, status: r.status, data };
  });
}

async function findContactByEmail(email) {
  const r = await sio("/contacts?email=" + encodeURIComponent(email) + "&limit=10");
  const items = (r.data && (r.data.items || r.data["hydra:member"])) || [];
  return items.find((c) => (c.email || "").toLowerCase() === email) || null;
}

let cachedTagId = null;
async function getTagId() {
  if (process.env.SYSTEMEIO_TAG_ID) return Number(process.env.SYSTEMEIO_TAG_ID);
  if (cachedTagId) return cachedTagId;
  const name = process.env.SYSTEMEIO_TAG_NAME || "ELEVATE - Optin video";
  const r = await sio("/tags?query=" + encodeURIComponent(name) + "&limit=100");
  const items = (r.data && (r.data.items || r.data["hydra:member"])) || [];
  let tag = items.find((t) => (t.name || "").trim().toLowerCase() === name.toLowerCase());
  if (!tag) {
    const c = await sio("/tags", { method: "POST", body: { name } });
    if (!c.ok) { console.error("Création du tag impossible", c.status, JSON.stringify(c.data)); return null; }
    tag = c.data;
  }
  cachedTagId = tag.id;
  return cachedTagId;
}

// Jeton signé (identifie le contact sur la page vidéo sans exposer son email)
function signToken(cid) {
  const secret = process.env.TRACK_SECRET || crypto.createHash("sha256").update("elv:" + process.env.SYSTEMEIO_API_KEY).digest("hex");
  const sig = crypto.createHmac("sha256", secret).update(String(cid)).digest("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 22);
  return cid + "." + sig;
}

function sha256(v) {
  return crypto.createHash("sha256").update(String(v).trim().toLowerCase()).digest("hex");
}

async function sendCapiLead(req, p) {
  const pixel = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN;
  if (!pixel || !token) return;
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const user_data = {
    em: [sha256(p.email)],
    ph: [sha256(p.phone.replace(/\D/g, ""))],
    fn: [sha256(p.first_name)],
    country: [sha256("ca")],
    client_ip_address: ip || undefined,
    client_user_agent: req.headers["user-agent"] || undefined,
    fbp: p.fbp || undefined,
    fbc: p.fbc || undefined,
  };
  const payload = {
    data: [{
      event_name: "Lead",
      event_time: Math.floor(Date.now() / 1000),
      event_id: p.event_id,
      action_source: "website",
      event_source_url: p.page_url,
      user_data,
      custom_data: { content_name: "Video ELEVATE 13min", lead_source: p.source },
    }],
  };
  try {
    await fetch(`https://graph.facebook.com/v21.0/${pixel}/events?access_token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("CAPI error", e);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Méthode non autorisée" });
  }

  const redirect = process.env.VIDEO_PAGE_URL;
  let p = req.body || {};
  if (typeof p === "string") { try { p = JSON.parse(p); } catch (_) { p = {}; } }

  // Anti-spam : le champ caché doit rester vide
  if (p.website) return res.status(200).json({ ok: true, redirect });

  const first_name = String(p.first_name || "").trim().slice(0, 80);
  const email = String(p.email || "").trim().toLowerCase();
  const phone = String(p.phone || "").trim().slice(0, 30);
  if (!first_name || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || phone.replace(/\D/g, "").length < 8) {
    return res.status(400).json({ error: "Merci de vérifier vos informations." });
  }
  if (!p.consent) return res.status(400).json({ error: "Merci de cocher la case de consentement." });

  if (!process.env.SYSTEMEIO_API_KEY || !redirect) {
    console.error("Variables d'environnement Systeme.io manquantes");
    return res.status(500).json({ error: "Configuration incomplète. Merci de réessayer plus tard." });
  }

  const phoneSlug = process.env.SYSTEMEIO_PHONE_SLUG || "phone_number";
  const fields = [
    { slug: "first_name", value: first_name },
    { slug: phoneSlug, value: phone },
  ];

  try {
    // 1) Création du contact
    let contact = null;
    let r = await sio("/contacts", { method: "POST", body: { email, locale: "fr", fields } });

    if (r.ok) {
      contact = r.data;
    } else {
      // Contact déjà existant ? → on le récupère et on met à jour ses champs
      contact = await findContactByEmail(email);
      if (contact) {
        const u = await sio("/contacts/" + contact.id, { method: "PATCH", patch: true, body: { fields } });
        if (!u.ok) {
          await sio("/contacts/" + contact.id, { method: "PATCH", patch: true, body: { fields: [fields[0]] } });
        }
      } else {
        // Échec probable sur le format du téléphone → nouvel essai sans ce champ
        console.warn("Création refusée", r.status, JSON.stringify(r.data));
        r = await sio("/contacts", { method: "POST", body: { email, locale: "fr", fields: [fields[0]] } });
        if (!r.ok) {
          console.error("Création impossible", r.status, JSON.stringify(r.data));
          return res.status(502).json({ error: "Impossible d'enregistrer votre inscription. Merci de réessayer." });
        }
        contact = r.data;
      }
    }

    // 2) Tag → déclenche l'automatisation Systeme.io
    const tagId = await getTagId();
    if (tagId) {
      const t = await sio(`/contacts/${contact.id}/tags`, { method: "POST", body: { tagId } });
      if (!t.ok && t.status !== 422) console.warn("Tag non ajouté", t.status, JSON.stringify(t.data));
    }

    // 3) API Conversions Meta (non bloquant pour l'utilisatrice)
    await sendCapiLead(req, { ...p, first_name, email, phone });

    let dest = redirect;
    if (contact && contact.id) dest += (redirect.includes("?") ? "&" : "?") + "t=" + encodeURIComponent(signToken(contact.id));
    return res.status(200).json({ ok: true, redirect: dest });
  } catch (e) {
    console.error("Erreur subscribe", e);
    return res.status(500).json({ error: "Une erreur est survenue. Merci de réessayer." });
  }
};
