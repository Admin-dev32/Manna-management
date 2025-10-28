// /api/stripe/webhook.js  (MANAGEMENT)
// Requiere: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET_MGMT,
//           GOOGLE_SERVICE_ACCOUNT_JSON (o GCP_CLIENT_EMAIL + GCP_PRIVATE_KEY),
//           CALENDAR_ID, TIMEZONE (p.ej. America/Los_Angeles)
//
// Nota: NO agregar CORS aquí; Stripe llama server-to-server.
// bodyParser debe estar desactivado para validar firma.

export const config = { api: { bodyParser: false }, runtime: 'nodejs' };

import Stripe from 'stripe';
import { getCalendarClient } from '../_google.js'; // mismo helper que usas en management

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// Reglas de agenda (puedes ajustar con envs)
const PREP_HOURS = Number(process.env.PREP_HOURS || 1);
const CLEAN_HOURS = Number(process.env.CLEAN_HOURS || 1);
const DAY_CAP = Number(process.env.DAY_CAP || 2); // máximo reservas por día

function pkgToHours(pkg) {
  if (pkg === '50-150-5h') return 2;
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2; // fallback
}

function addHours(d, h) { return new Date(d.getTime() + h * 3600e3); }
function blockWindow(startISO, liveHours) {
  const start = new Date(startISO);
  const blockStart = addHours(start, -PREP_HOURS);
  const blockEnd   = addHours(start,  liveHours + CLEAN_HOURS);
  return { blockStart, blockEnd };
}
function overlaps(aStart, aEnd, bStart, bEnd) { return !(aEnd <= bStart || aStart >= bEnd); }

// Leer RAW body para verificar firma
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  if (!process.env.STRIPE_WEBHOOK_SECRET_MGMT) {
    console.error('[webhook-mgmt] Missing STRIPE_WEBHOOK_SECRET_MGMT');
    return res.status(500).send('Server misconfigured');
  }

  // 1) Verificar firma de Stripe con RAW body
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    const buf = await readRawBody(req);
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET_MGMT);
  } catch (err) {
    console.error('[webhook-mgmt] signature/parse failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 2) Solo procesamos el checkout.session.completed
  if (event.type !== 'checkout.session.completed') {
    return res.json({ received: true, ignored: event.type });
  }

  const session = event.data.object;
  const md = session.metadata || {};

  try {
    const tz = process.env.TIMEZONE || 'America/Los_Angeles';
    const calId = process.env.CALENDAR_ID || 'primary';
    const calendar = getCalendarClient(); // usa tus credenciales GCP de _google.js

    // Campos clave desde metadata (manager flow envía todo como strings)
    const startISO = md.startISO;
    const pkg = md.pkg || '';
    const mainBar = md.mainBar || 'Booking';
    const hours = Number(md.hours || 0) || pkgToHours(pkg);

    if (!startISO || !hours) {
      console.warn('[webhook-mgmt] missing startISO/hours — skipping calendar insert');
      return res.json({ received: true, skipped: true });
    }

    // 3) Calcular ventana de bloqueo (prep + servicio + clean)
    const { blockStart, blockEnd } = blockWindow(startISO, hours);

    // 4) Cargar eventos del MISMO día (para capacidad y traslape)
    const day = new Date(startISO);
    const dayStart = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0,0,0));
    const dayEnd   = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 23,59,59));

    const list = await calendar.events.list({
      calendarId: calId,
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100
    });
    const items = (list.data.items || []).filter(e => e.status !== 'cancelled');

    // Idempotencia: si ya existe este pedido, lo actualizamos (orderId = session.id)
    const existing = items.find(e => e.extendedProperties?.private?.orderId === session.id);

    // Capacidad diaria
    const countToday = items.filter(e => e.id !== existing?.id).length;
    if (!existing && DAY_CAP > 0 && countToday >= DAY_CAP) {
      console.warn('[webhook-mgmt] capacity full for day');
      return res.json({ received: true, capacity: 'full' });
    }

    // Traslape (incluyendo prep+live+clean)
    const isOverlap = items.some(e => {
      const s = new Date(e.start?.dateTime || e.start?.date);
      const en = new Date(e.end?.dateTime || e.end?.date);
      return overlaps(blockStart, blockEnd, s, en) && e.id !== existing?.id;
    });
    if (!existing && isOverlap) {
      console.warn('[webhook-mgmt] overlap with another event. Skipping insert.');
      return res.json({ received: true, conflict: 'overlap' });
    }

    // 5) Construir el evento (manager)
    const total   = md.total || '';
    const dueNow  = md.dueNow || '';
    const discount = md.discountApplied || '';
    const payMode = md.payMode || '';

    const description = [
      '📋 Manager Booking (Stripe)',
      `Name: ${md.fullName || ''}`,
      md.email ? `Email: ${md.email}` : '',
      md.phone ? `Phone: ${md.phone}` : '',
      md.venue ? `Venue: ${md.venue}` : '',
      `Package: ${pkg}`,
      `Main Bar: ${mainBar}`,
      md.secondEnabled === 'true' ? `Second Bar: ${md.secondBar || ''} (${md.secondSize || ''})` : '',
      md.fountainEnabled === 'true' ? `Fountain: ${md.fountainSize || ''} (${md.fountainType || ''})` : '',
      md.addons ? `Add-ons: ${md.addons}` : '',
      `Date: ${md.dateISO || ''}`,
      `Start: ${startISO}`,
      `Service hours: ${hours}`,
      discount ? `Discount: -$${discount}` : '',
      total ? `Total: $${total}` : '',
      dueNow ? `Paid now: $${dueNow}` : '',
      payMode ? `Pay mode: ${payMode}` : '',
      `Stripe session: ${session.id}`
    ].filter(Boolean).join('\n');

    const requestBody = {
      summary: `MANAGER — ${mainBar} (${pkg}) — $${total || '0.00'}`,
      description,
      location: md.venue || '',
      start: { dateTime: blockStart.toISOString(), timeZone: tz },
      end:   { dateTime: blockEnd.toISOString(),   timeZone: tz },
      colorId: '7',
      extendedProperties: {
        private: {
          orderId: session.id, // idempotencia
          source: 'manager',
          pkg, mainBar,
          secondEnabled: md.secondEnabled || 'false',
          secondBar: md.secondBar || '',
          secondSize: md.secondSize || '',
          fountainEnabled: md.fountainEnabled || 'false',
          fountainSize: md.fountainSize || '',
          fountainType: md.fountainType || '',
          addons: md.addons || '',
          total: total || '',
          dueNow: dueNow || '',
          discount: discount || '',
          payMode: payMode || ''
        }
      },
      guestsCanInviteOthers: false,
      guestsCanModify: false,
      guestsCanSeeOtherGuests: false
    };

    if (existing) {
      await calendar.events.patch({
        calendarId: calId,
        eventId: existing.id,
        requestBody,
        sendUpdates: 'none'
      });
      return res.json({ received: true, updated: true });
    } else {
      await calendar.events.insert({
        calendarId: calId,
        requestBody,
        sendUpdates: 'none'
      });
      return res.json({ received: true, created: true });
    }
  } catch (err) {
    console.error('[webhook-mgmt] handler error:', err);
    return res.status(500).json({ error: 'server_error', detail: err.message });
  }
}
