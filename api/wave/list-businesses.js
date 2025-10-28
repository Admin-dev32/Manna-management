export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  // CORS simple por si lo abres desde hostinger para probar
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET') return res.status(405).json({ ok:false, error:'Method not allowed' });

  try {
    const rsp = await fetch('https://gql.waveapps.com/graphql/public', {
      method: 'POST',
      headers: {
        'Content-Type':'application/json',
        'Authorization': `Bearer ${process.env.WAVE_TOKEN}`
      },
      body: JSON.stringify({
        query: `query { businesses(page:1, pageSize:10) { edges { node { id name } } } }`
      })
    });
    const json = await rsp.json();
    if (json.errors) return res.status(400).json({ ok:false, errors: json.errors });
    return res.status(200).json({ ok:true, businesses: json.data.businesses.edges.map(e=>e.node) });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e.message });
  }
}
