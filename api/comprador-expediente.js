// =============================================================
//  api/comprador-expediente.js — Método NERI · Portal del comprador
//
//  El "portero" del portal de expediente documental del COMPRADOR.
//  Cuando el comprador abre el link (?folio=...&token=...), valida
//  folio + token y devuelve los datos para pintar el encabezado.
//  Sin token válido: 401. Flujo separado del expediente del propietario.
//
//  Validación de token (compatible con activación tardía):
//   - Si el lead ya tiene Token Expediente Comprador → se compara contra ese.
//   - Si está vacío → se compara contra el token determinista
//     HMAC('expediente-comprador:'+folio) y, si coincide, se guarda.
//
//  Variables Vercel: AIRTABLE_TOKEN, AIRTABLE_BASE, NERI_SESSION_SECRET
// =============================================================

import crypto from 'node:crypto';

const BASE = process.env.AIRTABLE_BASE || process.env.AIRTABLE_BASE_ID;
const TOKEN = process.env.AIRTABLE_TOKEN;
const SECRET = process.env.NERI_SESSION_SECRET;

const COMPRADORES_TABLE = 'tblOdlY3bBlGi64qR';
const TOKEN_SCOPE = 'expediente-comprador:';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });
  if (!TOKEN || !BASE || !SECRET) return res.status(500).json({ error: 'Faltan variables de entorno en Vercel.' });

  try {
    const { folio, token } = getQuery(req);
    if (!folio || !token) return res.status(400).json({ error: 'Faltan folio y token.' });

    const lead = await findLeadByFolio(folio);
    if (!lead) return res.status(404).json({ error: 'Expediente no encontrado.' });

    const stored = String(lead.fields['Token Expediente Comprador'] || '').trim();
    if (stored) {
      if (!safeEqual(token, stored)) return res.status(401).json({ error: 'Token inválido.' });
    } else {
      const deterministic = crypto.createHmac('sha256', SECRET).update(TOKEN_SCOPE + folio).digest('base64url');
      if (!safeEqual(token, deterministic)) return res.status(401).json({ error: 'Token inválido.' });
      // Activación tardía: guardamos el token para futuras validaciones
      try { await airPatch(COMPRADORES_TABLE, lead.id, { 'Token Expediente Comprador': token }); } catch (_) {}
    }

    const f = lead.fields || {};
    return res.status(200).json({
      ok: true,
      folio,
      nombre: f['Nombre Completo'] || '',
      propiedad: f['Propiedad de Interés'] || '',
      asesor: pickName(f['Asesor']) || '',
      progreso: f['Progreso Expediente Comprador'] || '',
      aviso_aceptado: Boolean(String(f['Aviso Privacidad Comprador'] || '').trim()),
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Error en comprador-expediente.' });
  }
}

/* ───────── Airtable ───────── */
function airHeaders() { return { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }; }
async function findLeadByFolio(folio) {
  const f = folio.replace(/'/g, "\\'");
  const formula = `OR({Folio del Comprador}='${f}', {Folio}='${f}')`;
  const url = `https://api.airtable.com/v0/${BASE}/${COMPRADORES_TABLE}?maxRecords=1&filterByFormula=${encodeURIComponent(formula)}`;
  const r = await fetch(url, { headers: airHeaders() });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || 'Error consultando el comprador.');
  return (data.records && data.records[0]) || null;
}
async function airPatch(table, id, fields) {
  const url = `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}/${id}`;
  const r = await fetch(url, { method: 'PATCH', headers: airHeaders(), body: JSON.stringify({ fields, typecast: true }) });
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error?.message || 'Error guardando en Airtable.'); }
  return r.json();
}

/* ───────── utilidades ───────── */
function getQuery(req) {
  const q = req.query || {};
  const host = req.headers?.host || 'localhost';
  const u = new URL(req.url || '/', 'https://' + host);
  return {
    folio: String(q.folio || u.searchParams.get('folio') || '').trim(),
    token: String(q.token || u.searchParams.get('token') || '').trim(),
  };
}
function pickName(v) { if (!v) return ''; if (typeof v === 'string') return v; if (v.name) return v.name; return String(v); }
function safeEqual(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}
