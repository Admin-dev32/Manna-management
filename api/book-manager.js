// /api/book-manager.js
export const config = { runtime: 'nodejs' };
import { google } from 'googleapis';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { dateISO, startISO, pkg, bar, name, email, phone, venue } = req.body;

    if (!dateISO || !startISO || !pkg || !bar || !name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');

    const jwt = new google.auth.JWT(
      sa.client_email,
      null,
      sa.private_key,
      ['https://www.googleapis.com/auth/calendar']
    );
    const calendar = google.calendar({ version: 'v3', auth: jwt });

    const tz = process.env.TIMEZONE || 'America/Los_Angeles';
    const calId = process.env.CALENDAR_ID || 'primary';

    const HOURS = { '50-150-5h': 2, '150-250-5h': 2.5, '250-350-6h': 3 };
    const liveHrs = HOURS[pkg] || 2;
    const start = new Date(startISO);
    const end = new Date(start.getTime() + liveHrs * 3600e3);

    const event = await calendar.events.insert({
      calendarId: calId,
      requestBody: {
        summary: `Manager Booking — ${bar} (${pkg})`,
        description: [
          `Created by manager manually`,
          `Name: ${name}`,
          email ? `Email: ${email}` : '',
          phone ? `Phone: ${phone}` : '',
          venue ? `Venue: ${venue}` : ''
        ].filter(Boolean).join('\n'),
        start: { dateTime: start.toISOString(), timeZone: tz },
        end: { dateTime: end.toISOString(), timeZone: tz },
        colorId: '7'
      }
    });

    return res.json({ ok: true, id: event.data.id, start: startISO });
  } catch (e) {
    console.error('book-manager error', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
