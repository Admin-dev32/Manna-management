// /api/wave.js
// Un único endpoint compatible con Vercel Hobby (1 función) que maneja:
// GET  ?action=env-check
// GET  ?action=ping
// GET  ?action=schema-check
// GET  ?action=list-businesses
// POST { action:"create-invoice", ...payload }
//
// ENV requeridas:
// - WAVE_TOKEN, WAVE_BUSINESS_ID, WAVE_CURRENCY=USD
// - WAVE_PRODUCT_ID_SERVICE, WAVE_PRODUCT_ID_ADDON, WAVE_PRODUCT_ID_TAX
// - TAX_RATE (p.ej. 0.0825) y TAX_APPLIES = 'after-discount' | 'before-discount'

export const config = { runtime: 'nodejs' };

const WAVE_API = 'https://gql.waveapps.com/graphql/public';

// ---------- helpers ----------
function cors(req, res) {
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

async function callWave(query, variables, token) {
  const rsp = await fetch(WAVE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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

const toMoneyStr = n => Number(n || 0).toFixed(2);
function normalizeAddons(addons) {
  if (!addons) return [];
  if (Array.isArray(addons)) {
    return addons.map(a => {
      if (typeof a === 'string') return { name: a.trim(), price: 0 };
      if (typeof a === 'object' && a) return { name: String(a.name || '').trim(), price: Number(a.price || 0) };
      return null;
    }).filter(Boolean);
  }
  return String(addons).split(',').map(s => ({ name: s.trim(), price: 0 })).filter(a => a.name);
}

// ---------- GraphQL ----------
const Q_PING = `
query Ping($businessId: ID!) {
  business(id: $businessId) { id name }
}`;

const Q_LIST_BUSINESSES = `
query ListBusinesses {
  businesses(page:1, pageSize:50) {
    edges { node { id name } }
  }
}`;

const Q_GET_CUSTOMER_BY_EMAIL = `
query GetCustomer($businessId: ID!, $email: String!) {
  business(id: $businessId) {
    customers(page:1, pageSize:1, email:$email) {
      edges { node { id name email } }
    }
  }
}`;

const M_CREATE_CUSTOMER = `
mutation CreateCustomer($input: CustomerCreateInput!) {
  customerCreate(input:$input) {
    didSucceed
    inputErrors { code message path }
    customer { id name email }
  }
}`;

const M_CREATE_INVOICE = `
mutation CreateInvoice($input: InvoiceCreateInput!) {
  invoiceCreate(input:$input) {
    didSucceed
    inputErrors { code message path }
    invoice { id status pdfUrl viewUrl }
  }
}`;

const M_APPROVE = `
mutation Approve($input: InvoiceApproveInput!) {
  invoiceApprove(input:$input) {
    didSucceed
    inputErrors { code message path }
    invoice { id status }
  }
}`;

// ---------- actions ----------
async function actionEnvCheck() {
  const present = (k) => Boolean(process.env[k] && String(process.env[k]).length > 0);
  return {
    ok: true,
    report: {
      WAVE_TOKEN: present('WAVE_TOKEN'),
      WAVE_BUSINESS_ID: present('WAVE_BUSINESS_ID'),
      WAVE_CURRENCY: present('WAVE_CURRENCY'),
      WAVE_PRODUCT_ID_SERVICE: present('WAVE_PRODUCT_ID_SERVICE'),
      WAVE_PRODUCT_ID_ADDON: present('WAVE_PRODUCT_ID_ADDON'),
      WAVE_PRODUCT_ID_TAX: present('WAVE_PRODUCT_ID_TAX'),
      TAX_RATE: present('TAX_RATE'),
      TAX_APPLIES: present('TAX_APPLIES')
    }
  };
}

async function actionPing() {
  const token = process.env.WAVE_TOKEN;
  const businessId = process.env.WAVE_BUSINESS_ID;
  if (!token || !businessId) throw new Error('WAVE_TOKEN/WAVE_BUSINESS_ID missing');
  const data = await callWave(Q_PING, { businessId }, token);
  return { ok: true, business: data?.business };
}

async function actionSchemaCheck() {
  // Ping es suficiente para validar token+business reach.
  return actionPing();
}

async function actionListBusinesses() {
  const token = process.env.WAVE_TOKEN;
  if (!token) throw new Error('WAVE_TOKEN missing');
  const data = await callWave(Q_LIST_BUSINESSES, {}, token);
  const edges = data?.businesses?.edges || [];
  return { ok: true, businesses: edges.map(e => e.node) };
}

async function actionCreateInvoice(payload) {
  const token = process.env.WAVE_TOKEN;
  const businessId = process.env.WAVE_BUSINESS_ID;
  const currency = process.env.WAVE_CURRENCY || 'USD';
  const PID_SERVICE = process.env.WAVE_PRODUCT_ID_SERVICE;
  const PID_ADDON   = process.env.WAVE_PRODUCT_ID_ADDON;
  const PID_TAX     = process.env.WAVE_PRODUCT_ID_TAX;
  const TAX_RATE    = Number(process.env.TAX_RATE || 0);
  const TAX_MODE    = (process.env.TAX_APPLIES || 'after-discount').toLowerCase();

  if (!token || !businessId) throw new Error('Wave not configured (WAVE_TOKEN / WAVE_BUSINESS_ID missing)');
  if (!PID_SERVICE || !PID_ADDON || !PID_TAX) throw new Error('Missing product IDs (SERVICE/ADDON/TAX)');

  const {
    fullName, email, phone, venue,
    pkg, mainBar, secondEnabled, secondBar, secondSize,
    fountainEnabled, fountainSize, fountainType,
    addons = [],
    discountMode = 'amount',
    discountValue = 0,
    total = 0, deposit = 0, balance = 0,
    payMode = 'deposit', notes = '',
    dateISO, startISO, hours = 0
  } = payload || {};

  // 1) Customer
  let customerId = null;
  if (email) {
    const found = await callWave(Q_GET_CUSTOMER_BY_EMAIL, { businessId, email }, token);
    customerId = found?.business?.customers?.edges?.[0]?.node?.id || null;
  }
  if (!customerId) {
    const input = { businessId, name: fullName || 'Booking Client', email: email || undefined, phone: phone || undefined };
    const out = await callWave(M_CREATE_CUSTOMER, { input }, token);
    if (!out.customerCreate?.didSucceed) {
      const errs = out.customerCreate?.inputErrors?.map(e => `${e.path?.join('.')}: ${e.message}`).join(' | ') || 'failed';
      throw new Error('customerCreate: ' + errs);
    }
    customerId = out.customerCreate.customer.id;
  }

  // 2) Totales (tax como línea positiva; descuento nativo)
  const addonsNorm = normalizeAddons(addons);
  const addonsSum = addonsNorm.reduce((s,a)=> s + Number(a.price || 0), 0);
  const subtotalBase = Number(total || 0) + addonsSum;

  let discountAmt = 0;
  if (discountMode === 'amount') {
    discountAmt = Math.max(0, Number(discountValue || 0));
  } else if (discountMode === 'percent') {
    const pct = Math.max(0, Number(discountValue || 0));
    discountAmt = +(subtotalBase * (pct/100)).toFixed(2);
  }

  const taxableBase = TAX_MODE === 'before-discount'
    ? Math.max(0, subtotalBase)
    : Math.max(0, subtotalBase - discountAmt);

  const taxAmount = +(taxableBase * TAX_RATE).toFixed(2);

  // 3) Items
  const items = [];
  items.push({
    productId: PID_SERVICE,
    description: `Booking — ${mainBar || 'Service'}${pkg ? ` (${pkg})` : ''}`,
    quantity: 1,
    unitPrice: toMoneyStr(total)
  });

  addonsNorm.forEach(a => {
    items.push({
      productId: PID_ADDON,
      description: `Add-on — ${a.name}`,
      quantity: 1,
      unitPrice: toMoneyStr(a.price || 0)
    });
  });

  if (TAX_RATE > 0 && taxAmount > 0) {
    const pctTxt = (TAX_RATE * 100).toFixed(2).replace(/\.00$/, '');
    items.push({
      productId: PID_TAX,
      description: `Sales Tax (${pctTxt}%)`,
      quantity: 1,
      unitPrice: toMoneyStr(taxAmount)
    });
  }

  const invoiceDiscounts = [];
  if (discountMode === 'amount' && discountAmt > 0) {
    invoiceDiscounts.push({ name: 'Manager Discount', discountType: 'FIXED', amount: toMoneyStr(discountAmt) });
  } else if (discountMode === 'percent' && Number(discountValue) > 0) {
    invoiceDiscounts.push({ name: 'Manager Discount', discountType: 'PERCENTAGE', percentage: Number(discountValue) });
  }

  const invoiceInput = {
    businessId,
    customerId,
    currency,
    status: "SAVED",
    title: "Event Booking",
    subhead: venue ? `Venue: ${venue}` : null,
    invoiceDate: new Date().toISOString().slice(0,10),
    dueDate: dateISO || new Date(Date.now() + 7 * 864e5).toISOString().slice(0,10),
    memo: [
      notes ? `Notes: ${notes}` : null,
      dateISO ? `Event Date: ${dateISO}` : null,
      startISO ? `Start: ${startISO}` : null,
      hours ? `Service Hours: ${hours}` : null,
      `Pay mode: ${payMode}`,
      `Deposit: $${toMoneyStr(deposit)}`,
      `Balance: $${toMoneyStr(balance)}`,
      `Tax applies: ${TAX_MODE}`
    ].filter(Boolean).join('\n'),
    items: items.map(li => ({
      productId: li.productId,
      description: li.description,
      quantity: 1,
      unitPrice: String(li.unitPrice)
    })),
    invoiceDiscounts: invoiceDiscounts.length ? invoiceDiscounts : undefined
  };

  const created = await callWave(M_CREATE_INVOICE, { input: invoiceInput }, token);
  const invOut = created.invoiceCreate;
  if (!invOut?.didSucceed) {
    const errs = invOut?.inputErrors?.map(e => `${e.path?.join('.')}: ${e.message}`).join(' | ') || 'failed';
    throw new Error('invoiceCreate: ' + errs);
  }
  const invoiceId = invOut.invoice?.id;

  const approved = await callWave(M_APPROVE, { input: { businessId, invoiceId } }, token);
  if (!approved?.invoiceApprove?.didSucceed) {
    const errs = approved?.invoiceApprove?.inputErrors?.map(e => `${e.path?.join('.')}: ${e.message}`).join(' | ') || 'failed';
    throw new Error('invoiceApprove: ' + errs);
  }

  return {
    ok: true,
    invoiceId,
    viewUrl: invOut.invoice?.viewUrl || null,
    pdfUrl: invOut.invoice?.pdfUrl || null,
    totals: {
      subtotalBase: toMoneyStr(subtotalBase),
      discount: toMoneyStr(discountAmt),
      taxableBase: toMoneyStr(taxableBase),
      tax: toMoneyStr(taxAmount)
    }
  };
}

// ---------- main handler ----------
export default async function handler(req, res) {
  try {
    if (cors(req, res)) return;

    const method = req.method;
    const action = (req.query.action || (method === 'POST' && (req.body?.action)) || '').toString().toLowerCase();

    if (method === 'GET') {
      if (action === 'env-check')       return res.json(await actionEnvCheck());
      if (action === 'ping')            return res.json(await actionPing());
      if (action === 'schema-check')    return res.json(await actionSchemaCheck());
      if (action === 'list-businesses') return res.json(await actionListBusinesses());
      return res.json({ ok:true, hint:'GET: ?action=env-check|ping|schema-check|list-businesses  •  POST: action=create-invoice' });
    }

    if (method === 'POST') {
      if (action === 'create-invoice' || !action) {
        const result = await actionCreateInvoice(req.body || {});
        return res.json(result);
      }
      return res.status(400).json({ ok:false, error:'Unknown action for POST' });
    }

    return res.status(405).json({ ok:false, error:'Method not allowed' });
  } catch (err) {
    console.error('[api/wave] crash:', err);
    return res.status(500).json({ ok:false, error:String(err.message) });
  }
}
