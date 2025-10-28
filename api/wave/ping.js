// /api/wave/ping.js
import { callWave, cors } from './_core';

const Q_PING = `
query Ping($businessId: ID!) {
  business(id: $businessId) {
    id
    name
  }
}
`;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ ok:false, error:'Method not allowed' });

  const token = process.env.WAVE_TOKEN;
  const businessId = process.env.WAVE_BUSINESS_ID;
  if (!token || !businessId) return res.status(500).json({ ok:false, error:'WAVE_TOKEN/WAVE_BUSINESS_ID missing' });

  try {
    const data = await callWave(Q_PING, { businessId }, token);
    return res.json({ ok:true, business: data?.business });
  } catch (err) {
    console.error('[wave/ping] ', err);
    return res.status(500).json({ ok:false, error: String(err.message) });
  }
}
