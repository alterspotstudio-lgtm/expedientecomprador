// =============================================================
//  api/idrive-read-url.js — Método NERI · Expediente del comprador
//
//  Lectura temporal (6 h) de documentos guardados en el bucket privado.
//  Solo sirve keys bajo el prefijo expediente-comprador/.
//
//  Auth (cualquiera de las dos):
//   - folio + token del expediente, y el folio debe coincidir con el
//     que vive dentro de la key (el comprador solo ve SUS documentos), o
//   - Bearer de sesión NERI (el asesor revisa desde la intranet).
//
//  Variables Vercel: IDRIVE_E2_*, AIRTABLE_TOKEN, AIRTABLE_BASE,
//                    NERI_SESSION_SECRET
// =============================================================

import crypto from 'node:crypto';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const EXPIRES_IN_SECONDS = 6 * 60 * 60; // 6 horas (estándar del proyecto)
const KEY_PREFIX = 'expediente-comprador/';
const TOKEN_SCOPE = 'expediente-comprador:';

const BASE = process.env.AIRTABLE_BASE || process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const SECRET = process.env.NERI_SESSION_SECRET;
const COMPRADORES_TABLE = 'tblOdlY3bBlGi64qR';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!['GET', 'POST', 'HEAD'].includes(req.method)) {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const cfg = readConfig();
  if (cfg.error) return res.status(500).json({ error: cfg.error });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const q = queryOf(req);
    const input = String(q.url || q.key || body.url || body.key || '').trim();
    const key = extractKey(input, cfg);

    if (!key) return res.status(400).json({ error: 'Falta URL o key del archivo.' });
    if (!key.startsWith(KEY_PREFIX)) return res.status(403).json({ error: 'Ruta no permitida.' });
    if (key.includes('..')) return res.status(403).json({ error: 'Ruta inválida.' });

    // ── Auth: sesión de asesor O folio+token del comprador
    const session = verifySession(req);
    if (!session) {
      const folio = String(q.folio || body.folio || '').trim();
      const token = String(q.token || body.token || '').trim();
      if (!folio || !token) return res.status(401).json({ error: 'Falta autorización.' });
      // El folio del request debe ser el de la key: el comprador solo ve lo suyo
      const keyFolio = key.slice(KEY_PREFIX.length).split('/')[0] || '';
      if (cleanPathPart(folio) !== keyFolio) return res.status(403).json({ error: 'Folio no coincide con el archivo.' });
      const lead = await findLeadByFolio(folio);
      if (!lead) return res.status(404).json({ error: 'Expediente no encontrado.' });
      if (!validToken(folio, token, lead.fields['Token Expediente Comprador'])) {
        return res.status(401).json({ error: 'Token inválido.' });
      }
    }

    const s3 = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });

    const command = new GetObjectCommand({ Bucket: cfg.bucket, Key: key });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: EXPIRES_IN_SECONDS });

    // Redirigir al link firmado funciona para <img>, <embed> y abrir en pestaña.
    res.setHeader('Location', signedUrl);
    return res.status(302).end();
  } catch (err) {
    return res.status(500).json({ error: 'No se pudo preparar la lectura: ' + (err?.message || err) });
  }
}

/* ───────── config ───────── */
function readConfig() {
  const endpoint = (process.env.IDRIVE_E2_ENDPOINT || '').replace(/\/$/, '');
  const region = process.env.IDRIVE_E2_REGION || 'us-west-2';
  const bucket = process.env.IDRIVE_E2_BUCKET || 'metodoneri';
  const accessKeyId = process.env.IDRIVE_E2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.IDRIVE_E2_SECRET_ACCESS_KEY;
  const publicBase = (process.env.IDRIVE_E2_PUBLIC_BASE || `${endpoint}/${bucket}`).replace(/\/$/, '');
  if (!endpoint) return { error: 'Falta IDRIVE_E2_ENDPOINT.' };
  if (!bucket) return { error: 'Falta IDRIVE_E2_BUCKET.' };
  if (!accessKeyId || !secretAccessKey) return { error: 'Faltan credenciales IDrive e2 en Vercel.' };
  return { endpoint, region, bucket, accessKeyId, secretAccessKey, publicBase };
}

/* ───────── key ───────── */
function extractKey(input, cfg) {
  if (!input) return '';
  if (!/^https?:\/\//i.test(input)) {
    return decodeURIComponent(input).replace(/^\/+/, '').replace(new RegExp('^' + escapeRegExp(cfg.bucket) + '/'), '');
  }
  try {
    const u = new URL(input);
    let path = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    path = path.replace(new RegExp('^' + escapeRegExp(cfg.bucket) + '/'), '');
    return path;
  } catch (_) { return ''; }
}
function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ───────── auth ───────── */
function queryOf(req) {
  const q = req.query || {};
  const host = req.headers?.host || 'localhost';
  const u = new URL(req.url || '/', 'https://' + host);
  const get = k => String(q[k] || u.searchParams.get(k) || '').trim();
  return { url: get('url'), key: get('key'), folio: get('folio'), token: get('token') };
}
function airHeaders() { return { Authorization: 'Bearer ' + AT_TOKEN, 'Content-Type': 'application/json' }; }
async function findLeadByFolio(folio) {
  const f = folio.replace(/'/g, "\\'");
  const formula = `OR({Folio del Comprador}='${f}', {Folio}='${f}')`;
  const url = `https://api.airtable.com/v0/${BASE}/${COMPRADORES_TABLE}?maxRecords=1&filterByFormula=${encodeURIComponent(formula)}`;
  const r = await fetch(url, { headers: airHeaders() });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || 'Error consultando el comprador.');
  return (data.records && data.records[0]) || null;
}
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
function verifySession(req) {
  if (!SECRET) return null;
  const raw = req.headers?.authorization || req.headers?.Authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(parts[0] + '.' + parts[1]).digest('base64url');
  const aa = Buffer.from(String(expected)); const bb = Buffer.from(String(parts[2]));
  if (aa.length !== bb.length || !crypto.timingSafeEqual(aa, bb)) return null;
  try { const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); if (p.exp && Date.now() > p.exp) return null; return p; }
  catch (_) { return null; }
}
function cleanPathPart(v) {
  return String(v || 'sin-dato')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'sin-dato';
}
