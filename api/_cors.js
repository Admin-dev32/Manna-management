// /api/_cors.js
export function withCORS(req, res) {
  // Si quieres restringir a tu Hostinger, cambia '*' por 'https://TU-DOMINIO.hostinger.site'
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true; // ya respondimos al preflight
  }
  return false;  // continuar con el handler normal
}
