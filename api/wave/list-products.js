// /api/wave/list-products.js
export const config = { runtime: 'nodejs' };

const WAVE_API = 'https://gql.waveapps.com/graphql/public';

async function wave(query, variables, token) {
  const rsp = await fetch(WAVE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables })
  });
  const json = await rsp.json();
  if (!rsp.ok || json.errors) {
    const errs = json.errors ? json.errors.map(e => e.message).join('; ') : `HTTP ${rsp.status}`;
    throw new Error(errs);
  }
  return json.data;
}

const Q_PRODUCTS = `
query Products($businessId: ID!) {
  business(id: $businessId) {
    id
    name
    products(page:1, pageSize:100) {
      edges {
        node { id name description }
      }
    }
  }
}`;

export default async function handler(req, res) {
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
    const data = await wave(Q_PRODUCTS, { businessId }, token);
    const edges = data?.business?.products?.edges || [];
    const products = edges.map(e => e.node);
    return res.json({ ok:true, business: data.business?.name, products });
  } catch (err) {
    console.error('[wave/list-products] error:', err);
    return res.status(500).json({ ok:false, error: err.message });
  }
}
