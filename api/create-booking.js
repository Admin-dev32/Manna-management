// /api/create-booking.js
export const config = { runtime: 'nodejs' };
import { getCalendarClient } from './_google.js';

const PREP_HOURS = 1, CLEAN_HOURS = 1;

function addHours(d, h){ return new Date(d.getTime() + h * 3600e3); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const data = req.body || {};
    const { fullName, dateISO, startISO, pkg, mainBar } = data;
    if (!fullName || !dateISO || !startISO || !pkg || !mainBar)
      return res.status(400).json({ error: 'Missing required fields' });

    const calendar = getCalendarClient();
    const tz = process.env.TIMEZONE || 'America/Los_Angeles';
    const calId = process.env.CALENDAR_ID || 'primary';

    const liveHours = data.hours || 2;
    const start = new Date(startISO);
    const blockStart = addHours(start, -PREP_HOURS);
    const blockEnd = addHours(start, liveHours + CLEAN_HOURS);

    // Calculate totals
    const total = parseFloat(data.total || 0);
    const deposit = parseFloat(data.deposit || 0);
    const discount = parseFloat(data.discount || 0);
    const balance = total - deposit - discount;

    const description = [
      '📋 Manager Booking (Manual)',
      `Name: ${fullName}`,
      `Package: ${pkg}`,
      `Main Bar: ${mainBar}`,
      data.secondEnabled ? `Second Bar: ${data.secondBar} (${data.secondSize})` : '',
      data.fountainEnabled ? `Fountain: ${data.fountainSize} (${data.fountainType})` : '',
      data.addons?.length ? `Add-ons: ${data.addons.join(', ')}` : '',
      `Date: ${dateISO}`,
      `Start: ${startISO}`,
      `Total: $${total.toFixed(2)}`,
      `Deposit: $${deposit.toFixed(2)}`,
      `Discount: $${discount.toFixed(2)}`,
      `Balance: $${balance.toFixed(2)}`,
      `Payment Method: ${data.paymentType || 'N/A'}`,
      `Notes: ${data.notes || ''}`
    ].filter(Boolean).join('\n');

    const summary = `MANAGER — ${mainBar} (${pkg}) — $${total.toFixed(2)}`;

    await calendar.events.insert({
      calendarId: calId,
      requestBody: {
        summary,
        description,
        start: { dateTime: blockStart.toISOString(), timeZone: tz },
        end: { dateTime: blockEnd.toISOString(), timeZone: tz },
        location: data.venue || '',
        colorId: '7',
        extendedProperties: {
          private: {
            pkg, mainBar,
            secondBar: data.secondBar || '',
            fountainType: data.fountainType || '',
            total, deposit, discount, balance,
            paymentType: data.paymentType || '',
            source: 'manual'
          }
        }
      }
    });

    res.json({ ok: true, message: 'Booking added to Google Calendar ✅' });
  } catch (err) {
    console.error('create-booking error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
}
