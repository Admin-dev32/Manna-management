// /api/create-booking.js
export const config = { runtime: 'nodejs' };

import { withCORS } from './_cors.js';
import { google } from 'googleapis';

const PREP_HOURS = 1, CLEAN_HOURS = 1;
const addHours = (d,h)=> new Date(d.getTime() + h*3600e3);
const pkgToHours = (pkg)=> pkg==='150-250-5h'?2.5 : (pkg==='250-350-6h'?3:2);

function getGoogleAuth(){
  // Opción A: GOOGLE_SERVICE_ACCOUNT_JSON (JSON entero)
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    const sa = JSON.parse(raw);
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    return new google.auth.JWT(
      sa.client_email,
      null,
      sa.private_key,
      ['https://www.googleapis.com/auth/calendar']
    );
  }
  // Opción B: GCP_CLIENT_EMAIL + GCP_PRIVATE_KEY
  const email = process.env.GCP_CLIENT_EMAIL;
  const key   = (process.env.GCP_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return new google.auth.JWT(
    email, null, key, ['https://www.googleapis.com/auth/calendar']
  );
}

export default async function handler(req, res){
  // CORS + preflight
  if (withCORS(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ ok:false, error:'Method not allowed' });
  }

  try{
    const d = req.body || {};
    const { fullName, dateISO, startISO, pkg, mainBar } = d;

    if(!fullName || !dateISO || !startISO || !pkg || !mainBar){
      return res.status(400).json({ ok:false, error:'Missing fields (fullName, dateISO, startISO, pkg, mainBar)' });
    }

    const jwt = getGoogleAuth();
    const calendar = google.calendar({ version:'v3', auth: jwt });

    const tz = process.env.TIMEZONE || 'America/Los_Angeles';
    const calId = process.env.CALENDAR_ID || 'primary';

    const liveHours = d.hours || pkgToHours(pkg);
    const start = new Date(startISO);
    const blockStart = addHours(start, -PREP_HOURS);
    const blockEnd   = addHours(start,  liveHours + CLEAN_HOURS);

    const summary = `MANAGER — ${mainBar} (${pkg}) — $${Number(d.total||0).toFixed(2)}`;
    const desc = [
      '📋 Manager Booking (Manual)',
      `Name: ${fullName}`,
      d.email ? `Email: ${d.email}` : '',
      d.phone ? `Phone: ${d.phone}` : '',
      d.venue ? `Venue: ${d.venue}` : '',
      `Package: ${pkg}`,
      `Main Bar: ${mainBar}`,
      d.secondEnabled ? `Second Bar: ${d.secondBar} (${d.secondSize})` : '',
      d.fountainEnabled ? `Fountain: ${d.fountainSize} (${d.fountainType})` : '',
      d.addons?.length ? `Add-ons: ${d.addons.join(', ')}` : '',
      `Date: ${dateISO}`,
      `Start: ${startISO}`,
      `Subtotal: $${Number(d.pkgTotal||0).toFixed(2)}`,
      `Discount: -$${Number(d.discountApplied||0).toFixed(2)}`,
      `Total: $${Number(d.total||0).toFixed(2)}`,
      `Deposit/Due now: $${Number(d.deposit||0).toFixed(2)}`,
      `Balance: $${Number(d.balance||0).toFixed(2)}`,
      `Pay mode: ${d.payMode || 'deposit'}`,
      `Notes: ${d.notes || ''}`
    ].filter(Boolean).join('\n');

    await calendar.events.insert({
      calendarId: calId,
      requestBody: {
        summary,
        description: desc,
        start: { dateTime: blockStart.toISOString(), timeZone: tz },
        end:   { dateTime: blockEnd.toISOString(),   timeZone: tz },
        location: d.venue || '',
        colorId: '7',
        extendedProperties: {
          private: {
            source: 'manager',
            pkg, mainBar,
            secondEnabled: String(!!d.secondEnabled),
            secondBar: d.secondBar || '',
            secondSize: d.secondSize || '',
            fountainEnabled: String(!!d.fountainEnabled),
            fountainSize: d.fountainSize || '',
            fountainType: d.fountainType || '',
            addons: (d.addons||[]).join('|'),
            subtotal: String(d.pkgTotal||0),
            discount: String(d.discountApplied||0),
            total: String(d.total||0),
            deposit: String(d.deposit||0),
            balance: String(d.balance||0),
            payMode: d.payMode || ''
          }
        }
      }
    });

    return res.status(200).json({ ok:true, message:'Booking añadido a Google Calendar ✅' });
  }catch(e){
    console.error('create-booking error', e);
    return res.status(500).json({ ok:false, error:e.message });
  }
}
