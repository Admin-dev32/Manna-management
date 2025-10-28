// /api/wave/ping.js
export const config = { runtime: 'nodejs' };

const WAVE_API = 'https://gql.waveapps.com/graphql/public';

export default async function handler(req, res) {
  // CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET') {
    return res.status(405).json({ ok:false, error:'Method not allowed' });
  }

  const token = process.env.WAVE_TOKEN;
  const businessId = process.env.WAVE_BUSINESS_ID;

  if (!token || !businessId) {
    return res.status(500).json({ ok:false, error:'WAVE_TOKEN/WAVE_BUSINESS_ID missing' });
  }

  const query = `
    query Ping($businessId: ID!) {
      business(id: $businessId) { id name }
    }
  `;

  try {
    const rsp = await fetch(WAVE_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ query, variables: { businessId } })
    });

    const text = await rsp.text(); // captura texto crudo por si no es JSON
    let json;
    try { json = JSON.parse(text); } catch (e) {
      // Wave devolvió HTML o texto -> mostramos tal cual
      return res.status(500).json({ ok:false, error:`Wave HTTP ${rsp.status}: ${text}` });
    }

    if (!rsp.ok || json.errors) {
      const errs = json.errors?.map(e => JSON.stringify(e)).join(' | ') || `HTTP ${rsp.status}`;
      return res.status(500).json({ ok:false, error:`Wave error: ${errs}` });
    }

    return res.json({ ok:true, business: json.data?.business });
  } catch (err) {
    console.error('[wave/ping] crash:', err);
    return res.status(500).json({ ok:false, error:String(err.message) });
  }
}
