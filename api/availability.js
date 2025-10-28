// /api/availability.js
export const config = { runtime: 'nodejs' };

const HOURS_RANGE = { start: 9, end: 22 }; // 9am–10pm
const PREP_HOURS = 1;
const CLEAN_HOURS = 1;
const DAY_CAP = 2;

function zonedStartISO(ymd, hour, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, 0, 0);
  const asDate = new Date(guess);
  const inTz = new Date(asDate.toLocaleString('en-US', { timeZone: tz }));
  const offsetMs = inTz.getTime() - asDate.getTime();
  return new Date(guess - offsetMs).toISOString();
}

export default async function handler(req, res) {
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  const origin = req.headers.origin || '';
  const okOrigin = allow.length ? allow.includes(origin) : true;

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', okOrigin ? origin : '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  res.setHeader('Access-Control-Allow-Origin', okOrigin ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const { google } = await import('googleapis');
    const { date, hours } = req.query || {};
    const tz = process.env.TIMEZONE || 'America/Los_Angeles';
    const calId = process.env.CALENDAR_ID || 'primary';
    const liveHours = Math.max(1, parseFloat(hours || '2'));

    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });

    const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');

    const jwt = new google.auth.JWT(
      sa.client_email,
      null,
      sa.private_key,
      ['https://www.googleapis.com/auth/calendar']
    );
    const calendar = google.calendar({ version: 'v3', auth: jwt });

    const dayStart = zonedStartISO(date, 0, tz);
    const dayEnd = zonedStartISO(date, 23, tz);

    const rsp = await calendar.events.list({
      calendarId: calId,
      timeMin: dayStart,
      timeMax: dayEnd,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100
    });

    const items = (rsp.data.items || []).filter(e => e.status !== 'cancelled');

    if (items.length >= DAY_CAP) {
      return res.json({ slots: [] });
    }

    const events = items.map(e => ({
      start: new Date(e.start?.dateTime || e.start?.date),
      end: new Date(e.end?.dateTime || e.end?.date)
    }));

    const slots = [];
    for (let h = HOURS_RANGE.start; h <= HOURS_RANGE.end; h++) {
      const startIso = zonedStartISO(date, h, tz);
      const start = new Date(startIso);
      const now = new Date();
      if (start < now) continue;

      const blockStart = new Date(start.getTime() - PREP_HOURS * 3600e3);
      const blockEnd = new Date(start.getTime() + (liveHours * 3600e3) + CLEAN_HOURS * 3600e3);

      const collides = events.some(ev => !(ev.end <= blockStart || ev.start >= blockEnd));
      if (!collides) slots.push({ startISO: startIso });
    }

    return res.json({ slots });
  } catch (e) {
    console.error('availability error', e);
    return res.status(500).json({ error: e.message });
  }
}
