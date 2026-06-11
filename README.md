# Expediente Documental del Comprador · Método NERI

Proyecto Vercel **independiente** del expediente del propietario.
Regla del sistema: los flujos vendedor y comprador nunca se mezclan.

## Despliegue (una sola vez)

1. **GitHub:** crea un repositorio nuevo (ej. `expediente-comprador`) y sube
   TODO el contenido de esta carpeta tal cual (index.html, api/, package.json).

2. **Vercel:** New Project → importa ese repo → el nombre del proyecto debe ser
   exactamente **expedientecomprador** (para que el dominio quede
   `expedientecomprador.vercel.app`, que es el que ya esperan la intranet y
   los endpoints). Si Vercel asigna otro dominio, cambia la constante
   `EXP_COMP_BASE` en `api/activar-expediente-comprador.js` y en el
   `index.html` de la intranet.

3. **Variables de entorno en Vercel** (Settings → Environment Variables) —
   copia los MISMOS valores que ya tienes en el proyecto de la intranet:

   - AIRTABLE_TOKEN
   - AIRTABLE_BASE
   - NERI_SESSION_SECRET
   - IDRIVE_E2_ENDPOINT
   - IDRIVE_E2_REGION
   - IDRIVE_E2_BUCKET
   - IDRIVE_E2_ACCESS_KEY_ID
   - IDRIVE_E2_SECRET_ACCESS_KEY
   - IDRIVE_E2_PUBLIC_BASE

4. **Airtable:** no hay que crear nada a mano. La primera activación crea
   sola los 4 campos en Compradores (Token / Link / Progreso / Aviso
   Privacidad Comprador) y la tabla "Expediente Comprador Documentos" con
   el checklist de 7 documentos. Si el token de Airtable no tuviera permiso
   de esquema, duplica la tabla "Expediente Documentos" vacía y renómbrala
   "Expediente Comprador Documentos" (el campo "Alerta 48h Enviada" sobra,
   no estorba).

## Funciones (6 de 12)

- activar-expediente-comprador — lo llama la intranet (Bearer de sesión)
- comprador-expediente — portero del portal (folio + token)
- expediente-comprador-documentos — listar / recibir / validar / rechazar
- upload-idrive-url — PUT firmado a iDrive (PDF/imagen, 50 MB, prefijo expediente-comprador/)
- idrive-read-url — lectura firmada 6 h (folio+token del comprador o sesión de asesor)
- aviso-privacidad-comprador — registro de aceptación (MN-EXPC-2026-06)

## Prueba de punta a punta

1. Sube el index.html nuevo de la intranet (entregado junto con esto).
2. Abre la ficha de un comprador con Conversión = Apartado.
3. Pulsa "Activar expediente" → aparece el link → ábrelo en el teléfono.
4. Acepta el aviso, sube una INE de prueba → en Airtable el renglón pasa a
   "Recibido" y el lead muestra "Documentos recibidos: 1/7".
