// /api/wave/schema-check.js
export const config = { runtime: 'nodejs' };
const WAVE_API = 'https://gql.waveapps.com/graphql/public';

async function callWave(query, variables, token) {
  const rsp = await fetch(WAVE_API, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${token}` },
    body: JSON.stringify({ query, variables })
  });
  const text = await rsp.text();
  let json;
  try { json = JSON.parse(text); } catch(e) {
    throw new Error(`Wave HTTP ${rsp.status}: ${text}`);
  }
  if (!rsp.ok || json.errors) {
    const errs = json.errors?.map(e=>JSON.stringify(e)).join(' | ') || `HTTP ${rsp.status}`;
    throw new Error(errs);
  }
  return json.data;
}

const Q_CHECK = `
query Check($businessId: ID!) {
  business(id: $businessId) {
    id
    name
    products(page:1, pageSize:1) { edges { node { id name } } }
  }
}`;

const M_DRY = `mutation Dry { __typename }`;

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

  try {
    const q = await callWave(Q_CHECK, { businessId }, token);
    let mutationEnabled = true, mutationError = null;
    try { await callWave(M_DRY, {}, token); }
    catch (e) { mutationEnabled = false; mutationError = String(e.message); }

    return res.json({ ok:true, business:q?.business, mutationEnabled, mutationError });
  } catch (e) {
    console.error('[wave/schema-check] crash:', e);
    return res.status(500).json({ ok:false, error:String(e.message) });
  }
}
