// =============================================================
//  api/aviso-privacidad-comprador.js — Método NERI
//
//  Registra la aceptación del aviso de privacidad del COMPRADOR en su
//  lead (campo Aviso Privacidad Comprador: versión + fecha ISO).
//  Auth: folio + token del expediente. Idempotente.
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (!TOKEN || !BASE || !SECRET) return res.status(500).json({ error: 'Faltan variables de entorno en Vercel.' });

  try {
    const body = parseBody(req);
    const folio = String(body.folio || '').trim();
    const token = String(body.token || '').trim();
    const version = String(body.version || 'MN-EXPC-2026-06').trim();
    if (!folio || !token) return res.status(400).json({ error: 'Faltan folio y token.' });

    const lead = await findLeadByFolio(folio);
    if (!lead) return res.status(404).json({ error: 'Expediente no encontrado.' });
    if (!validToken(folio, token, lead.fields['Token Expediente Comprador'])) {
      return res.status(401).json({ error: 'Token inválido.' });
    }

    // Idempotente: si ya hay aceptación registrada, no se sobreescribe
    const ya = String(lead.fields['Aviso Privacidad Comprador'] || '').trim();
    if (!ya) {
      await airPatch(COMPRADORES_TABLE, lead.id, {
        'Aviso Privacidad Comprador': version + ' · ' + new Date().toISOString(),
      });
    }
    return res.status(200).json({ ok: true, registrado: !ya });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'No se pudo registrar la aceptación.' });
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
function parseBody(req) { if (!req.body) return {}; if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } } return req.body; }
function validToken(folio, token, stored) {
  const s = String(stored || '').trim();
  if (s) return safeEqual(token, s);
  const deterministic = crypto.createHmac('sha256', SECRET).update(TOKEN_SCOPE + folio).digest('base64url');
  return safeEqual(token, deterministic);
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}
