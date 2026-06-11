// =============================================================
//  api/activar-expediente-comprador.js — Método NERI · Expediente del comprador
//
//  Espejo del flujo del propietario, 100% separado (regla inviolable:
//  los flujos vendedor y comprador nunca se mezclan).
//
//  Lo llama la INTRANET (Bearer de sesión NERI, mismo NERI_SESSION_SECRET):
//   1. El asesor pide el link del expediente de un comprador en Apartado.
//   2. Se genera UNA sola vez el token (idempotente, HMAC determinista) y
//      se guarda en el lead comprador junto con el link armado.
//   3. Se asegura que existan los 4 campos del expediente en Compradores
//      y la tabla "Expediente Comprador Documentos" (Meta API, idempotente),
//      y se siembra el checklist de 7 documentos en "Pendiente".
//   4. Devuelve SOLO el link armado (nunca el token suelto).
//
//  Variables Vercel: AIRTABLE_TOKEN, AIRTABLE_BASE, NERI_SESSION_SECRET
// =============================================================

import crypto from 'node:crypto';

const BASE = process.env.AIRTABLE_BASE || process.env.AIRTABLE_BASE_ID;
const TOKEN = process.env.AIRTABLE_TOKEN;
const SECRET = process.env.NERI_SESSION_SECRET;

const COMPRADORES_TABLE = 'tblOdlY3bBlGi64qR';        // Leads Compradores
const DOCS_TABLE = 'Expediente Comprador Documentos';  // se direcciona por nombre
const EXP_COMP_BASE = 'https://expedientecomprador.vercel.app';
const TOKEN_SCOPE = 'expediente-comprador:';           // esquema propio, distinto del vendedor

// Campos del expediente en la tabla Compradores (se crean solos si faltan)
const LEAD_FIELDS = [
  { name: 'Token Expediente Comprador',    type: 'singleLineText' },
  { name: 'Link Expediente Comprador',     type: 'url' },
  { name: 'Progreso Expediente Comprador', type: 'singleLineText' },
  { name: 'Aviso Privacidad Comprador',    type: 'singleLineText' },
];

// Checklist canónico del comprador (base universal; variantes de
// financiamiento se agregan en su propio módulo, al final del roadmap).
const DOCS = [
  { id: 'ine',               tipo: 'Identificación Oficial (INE)',             critico: true },
  { id: 'curp',              tipo: 'CURP',                                     critico: true },
  { id: 'constancia_fiscal', tipo: 'Constancia de Situación Fiscal',           critico: true },
  { id: 'domicilio',         tipo: 'Comprobante de Domicilio',                 critico: true },
  { id: 'acta_nacimiento',   tipo: 'Acta de Nacimiento',                       critico: false },
  { id: 'acta_matrimonio',   tipo: 'Acta de Matrimonio / Régimen Matrimonial', critico: false },
  { id: 'ingresos',          tipo: 'Comprobante de Ingresos / Estados de Cuenta', critico: false },
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  if (!TOKEN || !BASE) return res.status(500).json({ error: 'Faltan AIRTABLE_TOKEN y/o AIRTABLE_BASE en Vercel.' });
  if (!SECRET) return res.status(500).json({ error: 'Falta NERI_SESSION_SECRET en Vercel.' });
  if (!verifySession(req)) return res.status(401).json({ error: 'Sesión inválida o vencida.' });

  try {
    const body = parseBody(req);
    const folio = String(body.folio || '').trim();
    if (!folio) return res.status(400).json({ error: 'Falta el folio del comprador.' });

    // 1) Localizar el lead comprador por Folio del Comprador (operación) o Folio propio
    const lead = await findLeadByFolio(folio);
    if (!lead) return res.status(404).json({ error: 'No se encontró un comprador con ese folio.' });

    // 2) Regla de etapa: el expediente del comprador nace en Apartado (Capítulo 2)
    const conv = pickName(lead.fields['Conversión']);
    const fase = pickName(lead.fields['Fase Actual']);
    if (conv !== 'Apartado' && !fase) {
      return res.status(409).json({ error: 'El expediente del comprador sólo se activa a partir de Apartado.' });
    }

    // 3) Campos del expediente en Compradores: crear los que falten (idempotente)
    await ensureLeadFields().catch(() => {});

    // 4) Token idempotente
    let token = String(lead.fields['Token Expediente Comprador'] || '').trim();
    const link = buildLink(folio, token || (token = deterministicToken(folio)));

    const patch = {};
    if (!lead.fields['Token Expediente Comprador']) patch['Token Expediente Comprador'] = token;
    if (lead.fields['Link Expediente Comprador'] !== link) patch['Link Expediente Comprador'] = link;
    if (!lead.fields['Progreso Expediente Comprador']) patch['Progreso Expediente Comprador'] = 'Expediente activado · esperando documentos';
    if (Object.keys(patch).length) await airPatch(COMPRADORES_TABLE, lead.id, patch);

    // 5) Asegurar tabla + sembrar checklist (no bloquea la respuesta si falla)
    let tablaLista = false;
    try {
      tablaLista = await ensureDocsTable();
      if (tablaLista) await seedChecklist(folio, lead);
    } catch (_) { tablaLista = false; }

    return res.status(200).json({ ok: true, folio, link, tabla_documentos: tablaLista });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'No se pudo activar el expediente del comprador.' });
  }
}

/* ───────── token ───────── */
function deterministicToken(folio) {
  return crypto.createHmac('sha256', SECRET).update(TOKEN_SCOPE + folio).digest('base64url');
}
function buildLink(folio, token) {
  return EXP_COMP_BASE + '/?folio=' + encodeURIComponent(folio) + '&token=' + encodeURIComponent(token);
}

/* ───────── Airtable REST ───────── */
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
async function airListDocs(folio) {
  const formula = "{Folio}='" + folio.replace(/'/g, "\\'") + "'";
  const url = `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(DOCS_TABLE)}?filterByFormula=${encodeURIComponent(formula)}`;
  const r = await fetch(url, { headers: airHeaders() });
  if (!r.ok) return null;                 // tabla aún no existe
  const data = await r.json();
  return data.records || [];
}
async function airCreate(table, records) {
  const url = `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`;
  const r = await fetch(url, { method: 'POST', headers: airHeaders(), body: JSON.stringify({ records, typecast: true }) });
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error?.message || 'Error creando registros.'); }
  return r.json();
}

/* ───────── campos del expediente en Compradores (Meta API, idempotente) ───────── */
async function ensureLeadFields() {
  for (const field of LEAD_FIELDS) {
    const url = `https://api.airtable.com/v0/meta/bases/${BASE}/tables/${COMPRADORES_TABLE}/fields`;
    // Si el campo ya existe, Airtable responde 422 DUPLICATE y lo ignoramos.
    await fetch(url, { method: 'POST', headers: airHeaders(), body: JSON.stringify(field) }).catch(() => {});
  }
}

/* ───────── tabla "Expediente Comprador Documentos" (Meta API, idempotente) ───────── */
async function ensureDocsTable() {
  const probe = await airListDocs('__probe__');
  if (probe !== null) return true;
  const schema = {
    name: DOCS_TABLE,
    description: 'Un renglón por documento del expediente del COMPRADOR. Estado, archivo, validación. Flujo separado del expediente del propietario.',
    fields: [
      { name: 'Documento', type: 'singleLineText' },
      { name: 'Folio', type: 'singleLineText' },
      { name: 'Tipo de Documento', type: 'singleLineText' },
      { name: 'Document ID', type: 'singleLineText' },
      { name: 'Estado del Documento', type: 'singleSelect', options: { choices: [
        { name: 'Pendiente' }, { name: 'Recibido' }, { name: 'Validado' }, { name: 'Rechazado' }, { name: 'No aplica' },
      ] } },
      { name: 'Documento Crítico', type: 'checkbox', options: { icon: 'check', color: 'redBright' } },
      { name: 'Archivo URL', type: 'url' },
      { name: 'Nombre Archivo', type: 'singleLineText' },
      { name: 'Subido por', type: 'singleSelect', options: { choices: [
        { name: 'Cliente' }, { name: 'Asesor' }, { name: 'Sistema' },
      ] } },
      { name: 'Fecha Solicitud', type: 'dateTime', options: { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'America/Mexico_City' } },
      { name: 'Fecha de Carga', type: 'dateTime', options: { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'America/Mexico_City' } },
      { name: 'Motivo de Rechazo', type: 'multilineText' },
      { name: 'Asesor', type: 'singleLineText' },
    ],
  };
  const r = await fetch(`https://api.airtable.com/v0/meta/bases/${BASE}/tables`, { method: 'POST', headers: airHeaders(), body: JSON.stringify(schema) });
  return r.ok;
}

async function seedChecklist(folio, lead) {
  const existing = await airListDocs(folio);
  if (existing === null) return;          // tabla no disponible
  if (existing.length > 0) return;        // ya sembrado (idempotente)
  const asesor = pickName(lead.fields['Asesor']) || '';
  const now = new Date().toISOString();
  const records = DOCS.map(d => ({
    fields: {
      'Documento': folio + ' · ' + d.tipo,
      'Folio': folio,
      'Tipo de Documento': d.tipo,
      'Document ID': d.id,
      'Estado del Documento': 'Pendiente',
      'Documento Crítico': d.critico,
      'Subido por': 'Sistema',
      'Fecha Solicitud': now,
      'Asesor': asesor,
    },
  }));
  await airCreate(DOCS_TABLE, records);   // 7 registros, bajo el límite de 10
}

/* ───────── utilidades ───────── */
function pickName(v) { if (!v) return ''; if (typeof v === 'string') return v; if (v.name) return v.name; return String(v); }
function parseBody(req) { if (!req.body) return {}; if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } } return req.body; }

function verifySession(req) {
  const raw = req.headers?.authorization || req.headers?.Authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(parts[0] + '.' + parts[1]).digest('base64url');
  const aa = Buffer.from(String(expected));
  const bb = Buffer.from(String(parts[2]));
  if (aa.length !== bb.length || !crypto.timingSafeEqual(aa, bb)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (_) { return null; }
}
