// /api/wave/_core.js
export const WAVE_API = 'https://gql.waveapps.com/graphql/public';

export async function callWave(query, variables, token) {
  const rsp = await fetch(WAVE_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ query, variables })
  });

  const text = await rsp.text();
  let json;
  try { json = JSON.parse(text); } catch (e) {
    throw new Error(`Wave HTTP ${rsp.status}: ${text}`);
  }

  if (!rsp.ok || json.errors) {
    const errs = json.errors?.map(e => JSON.stringify(e)).join(' | ') || `HTTP ${rsp.status}`;
    throw new Error(`Wave error: ${errs}`);
  }
  return json.data;
}

export function cors(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
    return true;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  return false;
}
