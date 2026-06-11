// =============================================================
//  api/upload-idrive-url.js — Método NERI · Expediente del comprador
//
//  Genera una URL firmada S3-compatible (PUT, 15 min) para que el
//  COMPRADOR suba su documento directo al bucket privado de IDrive e2,
//  sin pasar el archivo por Vercel Functions.
//
//  Auth: folio + token del expediente (el comprador NO tiene sesión).
//  Tipos permitidos: PDF e imágenes. Máximo 50 MB.
//  Key: expediente-comprador/{folio}/{doc}/{stamp}-{rand}{ext}
//
//  Variables Vercel: IDRIVE_E2_* , AIRTABLE_TOKEN, AIRTABLE_BASE,
//                    NERI_SESSION_SECRET
// =============================================================

import crypto from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const BASE = process.env.AIRTABLE_BASE || process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const SECRET = process.env.NERI_SESSION_SECRET;

const COMPRADORES_TABLE = 'tblOdlY3bBlGi64qR';
const TOKEN_SCOPE = 'expediente-comprador:';
const KEY_PREFIX = 'expediente-comprador/';

const MAX_MB = 50;
const ALLOWED_TYPES = new Set([
  'application/pdf',
  'image/jpeg', 'image/jpg', 'image/png', 'image/heic', 'image/heif', 'image/webp',
]);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (!AT_TOKEN || !BASE || !SECRET) return res.status(500).json({ error: 'Faltan variables de entorno en Vercel.' });

  const cfg = readConfig();
  if (cfg.error) return res.status(500).json({ error: cfg.error });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const folio = String(body.folio || '').trim();
    const token = String(body.token || '').trim();
    if (!folio || !token) return res.status(400).json({ error: 'Faltan folio y token.' });

    // Auth del comprador: folio + token contra el lead
    const lead = await findLeadByFolio(folio);
    if (!lead) return res.status(404).json({ error: 'Expediente no encontrado.' });
    if (!validToken(folio, token, lead.fields['Token Expediente Comprador'])) {
      return res.status(401).json({ error: 'Token inválido.' });
    }

    const filename = cleanFilename(body.filename || 'documento.pdf');
    const contentType = String(body.contentType || 'application/pdf').trim().toLowerCase();
    const size = Number(body.size || 0);
    const doc = cleanPathPart(body.doc || 'documento');

    if (!ALLOWED_TYPES.has(contentType)) {
      return res.status(400).json({ error: 'Solo se permiten PDF o imágenes (JPG, PNG, HEIC, WEBP).' });
    }
    if (size > MAX_MB * 1024 * 1024) {
      return res.status(413).json({ error: `El archivo supera el límite de ${MAX_MB} MB.` });
    }

    const ext = extensionFrom(filename, contentType);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rand = crypto.randomBytes(5).toString('hex');
    const key = `${KEY_PREFIX}${cleanPathPart(folio)}/${doc}/${stamp}-${rand}${ext}`;

    const s3 = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });

    const command = new PutObjectCommand({ Bucket: cfg.bucket, Key: key, ContentType: contentType });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 15 * 60 });
    const publicBase = (cfg.publicBase || `${cfg.endpoint.replace(/\/$/, '')}/${cfg.bucket}`).replace(/\/$/, '');
    const url = `${publicBase}/${key.split('/').map(encodeURIComponent).join('/')}`;

    return res.status(200).json({
      uploadUrl,
      url,
      key,
      method: 'PUT',
      expiresIn: 900,
      headers: { 'Content-Type': contentType },
    });
  } catch (err) {
    return res.status(500).json({ error: 'No se pudo preparar la subida: ' + (err?.message || err) });
  }
}

/* ───────── config iDrive ───────── */
function readConfig() {
  const endpoint = (process.env.IDRIVE_E2_ENDPOINT || '').replace(/\/$/, '');
  const region = process.env.IDRIVE_E2_REGION || 'us-west-2';
  const bucket = process.env.IDRIVE_E2_BUCKET || 'metodoneri';
  const accessKeyId = process.env.IDRIVE_E2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.IDRIVE_E2_SECRET_ACCESS_KEY;
  const publicBase = process.env.IDRIVE_E2_PUBLIC_BASE || '';
  if (!endpoint) return { error: 'Falta IDRIVE_E2_ENDPOINT.' };
  if (!bucket) return { error: 'Falta IDRIVE_E2_BUCKET.' };
  if (!accessKeyId || !secretAccessKey) return { error: 'Faltan credenciales IDrive e2 en Vercel.' };
  return { endpoint, region, bucket, accessKeyId, secretAccessKey, publicBase };
}

/* ───────── Airtable: validación folio+token ───────── */
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

/* ───────── limpieza ───────── */
function cleanPathPart(v) {
  return String(v || 'sin-dato')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'sin-dato';
}
function cleanFilename(v) {
  return String(v || 'documento.pdf')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .slice(0, 120) || 'documento.pdf';
}
function extensionFrom(filename, contentType) {
  const m = String(filename).match(/\.[a-zA-Z0-9]{2,6}$/);
  if (m) return m[0].toLowerCase();
  if (contentType === 'application/pdf') return '.pdf';
  if (contentType === 'image/png') return '.png';
  if (contentType === 'image/webp') return '.webp';
  if (contentType === 'image/heic' || contentType === 'image/heif') return '.heic';
  return '.jpg';
}
