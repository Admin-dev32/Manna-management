// /api/wave/env-check.js
export const config = { runtime: 'nodejs' };

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

  try {
    const present = (k) => Boolean(process.env[k] && String(process.env[k]).length > 0);
    const report = {
      WAVE_TOKEN:        present('WAVE_TOKEN'),
      WAVE_BUSINESS_ID:  present('WAVE_BUSINESS_ID'),
      WAVE_CURRENCY:     present('WAVE_CURRENCY'),
      WAVE_PRODUCT_ID_SERVICE: present('WAVE_PRODUCT_ID_SERVICE'),
      WAVE_PRODUCT_ID_ADDON:   present('WAVE_PRODUCT_ID_ADDON'),
      WAVE_PRODUCT_ID_TAX:     present('WAVE_PRODUCT_ID_TAX'),
      TAX_RATE:          present('TAX_RATE'),
      TAX_APPLIES:       present('TAX_APPLIES')
    };
    return res.json({ ok:true, report });
  } catch (e) {
    console.error('[env-check] crash', e);
    return res.status(500).json({ ok:false, error: String(e.message) });
  }
}
