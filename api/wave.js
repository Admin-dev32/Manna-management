// /api/wave.js  (o /api/wave/index.js)
// Vercel Serverless Function — Integración Wave (unificada)

const WAVE_GQL = 'https://gql.waveapps.com/graphql/public';

/* -------------------- Utils -------------------- */
function json(res, code, body) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.status(code).json(body);
}

function toBase64(s) { return Buffer.from(s, 'utf8').toString('base64'); }
function fromBase64(s) { return Buffer.from(s, 'base64').toString('utf8'); }

function looksLikeGlobalBusinessId(bid) {
  return typeof bid === 'string' && bid.startsWith('QnVzaW5lc3M6');
}
function ensureBusinessIdB64(envVal) {
  if (!envVal) throw new Error('WAVE_BUSINESS_ID no definido');
  if (looksLikeGlobalBusinessId(envVal)) return envVal;
  if (envVal.includes('-')) return toBase64(`Business:${envVal}`);
  return envVal;
}
function looksLikeGlobalCustomerId(id) {
  return typeof id === 'string' && id.startsWith('QnVzaW5lc3M6') && id.includes('O0N1c3RvbWVyO');
}
function normalizeCustomerId({ businessUuid, customerId }) {
  if (!customerId) return null;
  if (looksLikeGlobalCustomerId(customerId)) return customerId;
  if (/^\d+$/.test(customerId)) {
    const raw = `Business:${businessUuid};Customer:${customerId}`;
    return toBase64(raw);
  }
  return customerId;
}
async function waveCall(token, query, variables) {
  const rsp = await fetch(WAVE_GQL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await rsp.json();
  if (j.errors) {
    const first = Array.isArray(j.errors) ? j.errors[0] : j.errors;
    throw new Error(`Wave error: ${JSON.stringify(first)}`);
  }
  return j.data;
}
function pick(n, def = 0) {
  const v = parseFloat(n);
  return Number.isFinite(v) ? v : def;
}

/** Parse JSON body robusto (objeto, string o stream) */
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

/* -------------------- GraphQL Docs -------------------- */
const Q_BUSINESSES = `
query {
  businesses(page: 1, pageSize: 50) { edges { node { id name } } }
}`;
const Q_BUSINESS = `
query ($id: ID!) { business(id: $id) { id name } }`;
const Q_PRODUCTS = `
query ($businessId: ID!) {
  business(id: $businessId) {
    id name
    products(page: 1, pageSize: 200) { edges { node { id name description } } }
  }
}`;
const Q_TAXES = `
query ($businessId: ID!) {
  business(id: $businessId) {
    id name
    salesTaxes(page: 1, pageSize: 100) { edges { node { id name rate } } }
  }
}`;
const MUT_CUSTOMER_CREATE = `
mutation TestCreateCustomer($input: CustomerCreateInput!) {
  customerCreate(input: $input) {
    didSucceed
    inputErrors { code message path }
    customer { id name email }
  }
}`;
const MUT_INVOICE_CREATE = `
mutation ($input: InvoiceCreateInput!) {
  invoiceCreate(input: $input) {
    didSucceed
    inputErrors { message code path }
    invoice {
      id status
      total { value currency { code } }
      taxTotal { value }
      viewUrl pdfUrl
    }
  }
}`;
const MUT_INVOICE_APPROVE = `
mutation ($input: InvoiceApproveInput!) {
  invoiceApprove(input: $input) {
    didSucceed
    inputErrors { message code path }
    invoice { id status }
  }
}`;

/* -------------------- Mappers/Derivadores -------------------- */
function mapItemsToWave({ items, env, taxMode }) {
  const out = [];
  for (const it of items || []) {
    const q = it.quantity == null ? 1 : it.quantity;
    let productId = null;
    if (it.kind === 'service')   productId = env.WAVE_PRODUCT_ID_SERVICE;
    else if (it.kind === 'addon')    productId = env.WAVE_PRODUCT_ID_ADDON;
    else if (it.kind === 'discount') productId = env.WAVE_PRODUCT_ID_DISCOUNT || env.WAVE_PRODUCT_ID_ADDON;
    else if (it.kind === 'tax')      productId = env.WAVE_PRODUCT_ID_TAX;
    if (!productId) throw new Error(`Unknown or missing productId for kind=${it.kind}`);

    const line = {
      productId,
      description: it.description || undefined,
      unitPrice: String(it.unitPrice),
      quantity: q,
    };
    // impuesto nativo por renglón
    if (env.WAVE_SALES_TAX_ID && taxMode === 'native' && it.kind !== 'discount') {
      line.taxes = [{ salesTaxId: env.WAVE_SALES_TAX_ID }];
    }
    out.push(line);
  }
  return out;
}
function computeDerivedLines({ subtotal, discountMode, discountValue, taxRate, taxApplies }) {
  const sub = pick(subtotal);
  let discountLineAmount = 0;
  if (discountMode === 'amount')  discountLineAmount = pick(discountValue);
  if (discountMode === 'percent') discountLineAmount = sub * (pick(discountValue) / 100);

  const baseTax = (taxApplies === 'before-discount')
    ? sub
    : Math.max(0, sub - discountLineAmount);
  const taxLineAmount = baseTax * pick(taxRate);

  return { discountLineAmount, taxLineAmount };
}

async function ensureCustomer({ token, businessIdB64, fullName, email }) {
  const safeEmail = (email && String(email).includes('@'))
    ? email
    : `no-email+${Date.now()}@manna.local`;
  const vars = { input: { businessId: businessIdB64, name: fullName || 'Manna Booking', email: safeEmail } };
  const data = await waveCall(token, MUT_CUSTOMER_CREATE, vars);
  if (!data?.customerCreate?.didSucceed) {
    const ie = data?.customerCreate?.inputErrors || [];
    throw new Error(`customerCreate failed: ${JSON.stringify(ie)}`);
  }
  return data.customerCreate.customer.id;
}

/* -------------------- Handler -------------------- */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    return res.status(204).end();
  }

  try {
    const action = (req.query.action || '').toString();
    const body = await readBody(req);

    const env = {
      WAVE_TOKEN: process.env.WAVE_TOKEN,
      WAVE_BUSINESS_ID: process.env.WAVE_BUSINESS_ID,
      WAVE_CURRENCY: process.env.WAVE_CURRENCY || 'USD',

      WAVE_PRODUCT_ID_SERVICE: process.env.WAVE_PRODUCT_ID_SERVICE,
      WAVE_PRODUCT_ID_ADDON: process.env.WAVE_PRODUCT_ID_ADDON,
      WAVE_PRODUCT_ID_DISCOUNT: process.env.WAVE_PRODUCT_ID_DISCOUNT,
      WAVE_PRODUCT_ID_TAX: process.env.WAVE_PRODUCT_ID_TAX,

      TAX_RATE: process.env.TAX_RATE,
      TAX_APPLIES: process.env.TAX_APPLIES || 'after-discount',
      WAVE_SALES_TAX_ID: process.env.WAVE_SALES_TAX_ID,

      WAVE_INVOICE_AUTO_APPROVE: process.env.WAVE_INVOICE_AUTO_APPROVE === 'true',
    };

    if (req.method === 'GET' && !action) {
      return json(res, 200, { ok: true });
    }

    /* --- utils --- */
    if (action === 'env-check') {
      return json(res, 200, {
        ok: true,
        report: {
          WAVE_TOKEN: !!env.WAVE_TOKEN,
          WAVE_BUSINESS_ID: !!env.WAVE_BUSINESS_ID,
          WAVE_CURRENCY: !!env.WAVE_CURRENCY,
          WAVE_PRODUCT_ID_SERVICE: !!env.WAVE_PRODUCT_ID_SERVICE,
          WAVE_PRODUCT_ID_ADDON: !!env.WAVE_PRODUCT_ID_ADDON,
          WAVE_PRODUCT_ID_DISCOUNT: !!env.WAVE_PRODUCT_ID_DISCOUNT,
          WAVE_PRODUCT_ID_TAX: !!env.WAVE_PRODUCT_ID_TAX,
          TAX_RATE: !!env.TAX_RATE,
          TAX_APPLIES: !!env.TAX_APPLIES,
          WAVE_SALES_TAX_ID: !!env.WAVE_SALES_TAX_ID,
          WAVE_INVOICE_AUTO_APPROVE: env.WAVE_INVOICE_AUTO_APPROVE,
        },
      });
    }

    if (action === 'ping') {
      const businessIdB64 = ensureBusinessIdB64(env.WAVE_BUSINESS_ID);
      const data = await waveCall(env.WAVE_TOKEN, Q_BUSINESS, { id: businessIdB64 });
      return json(res, 200, { ok: true, business: data.business, usedBusinessId: businessIdB64 });
    }

    if (action === 'list-businesses') {
      const data = await waveCall(env.WAVE_TOKEN, Q_BUSINESSES, {});
      const list = (data?.businesses?.edges || []).map(e => e.node);
      return json(res, 200, { ok: true, businesses: list });
    }

    if (action === 'list-products') {
      const businessIdB64 = ensureBusinessIdB64(env.WAVE_BUSINESS_ID);
      const data = await waveCall(env.WAVE_TOKEN, Q_PRODUCTS, { businessId: businessIdB64 });
      const prods = (data?.business?.products?.edges || []).map(e => e.node);
      return json(res, 200, { ok: true, business: data?.business, products: prods });
    }

    if (action === 'list-taxes') {
      const businessIdB64 = ensureBusinessIdB64(env.WAVE_BUSINESS_ID);
      const data = await waveCall(env.WAVE_TOKEN, Q_TAXES, { businessId: businessIdB64 });
      const taxes = (data?.business?.salesTaxes?.edges || []).map(e => e.node);
      return json(res, 200, { ok: true, business: data?.business, taxes });
    }

    /* --- create-invoice --- */
    if (action === 'create-invoice') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });

      const businessUuid = env.WAVE_BUSINESS_ID.includes('-')
        ? env.WAVE_BUSINESS_ID
        : fromBase64(env.WAVE_BUSINESS_ID).split(':')[1];
      const businessIdB64 = ensureBusinessIdB64(env.WAVE_BUSINESS_ID);

      const {
        fullName, email, customerId,
        items = [],
        pkgTotal, addonsTotal, discountMode, discountValue,
        currency = env.WAVE_CURRENCY || 'USD',
        venue, phone, dateISO, startISO, hours, notes,
        total, deposit, balance, payMode,
        dry
      } = (body || {});

      let customerGid = normalizeCustomerId({ businessUuid, customerId });
      if (!customerGid) {
        customerGid = await ensureCustomer({
          token: env.WAVE_TOKEN,
          businessIdB64,
          fullName,
          email,
        });
      }

      const taxMode = env.WAVE_SALES_TAX_ID ? 'native' : 'line';
      const taxRate = env.TAX_RATE ? parseFloat(env.TAX_RATE) : 0;
      const taxApplies = env.TAX_APPLIES || 'after-discount';

      let waveItems = [];

      if (items.length) {
        waveItems = mapItemsToWave({ items, env, taxMode });

        if (taxMode === 'line' && taxRate > 0) {
          const positive = items
            .filter(x => x.kind !== 'discount')
            .reduce((a, b) => a + pick(b.unitPrice) * (b.quantity ?? 1), 0);
          const negatives = items
            .filter(x => x.kind === 'discount')
            .reduce((a, b) => a + Math.abs(pick(b.unitPrice)) * (b.quantity ?? 1), 0);
          const base = (taxApplies === 'before-discount') ? positive : Math.max(0, positive - negatives);
          const taxAmt = base * taxRate;

          waveItems.push({
            productId: env.WAVE_PRODUCT_ID_TAX,
            description: `Sales Tax (${(taxRate * 100).toFixed(2)}%)`,
            unitPrice: String(taxAmt.toFixed(2)),
            quantity: 1,
          });
        }
      } else {
        const sub = pick(pkgTotal) + pick(addonsTotal);
        const { discountLineAmount, taxLineAmount } = computeDerivedLines({
          subtotal: sub, discountMode, discountValue, taxRate, taxApplies,
        });

        if (pick(pkgTotal) > 0) {
          waveItems.push({
            productId: env.WAVE_PRODUCT_ID_SERVICE,
            description: 'Service',
            unitPrice: String(pick(pkgTotal).toFixed(2)),
            quantity: 1,
            ...(taxMode === 'native' && env.WAVE_SALES_TAX_ID ? { taxes: [{ salesTaxId: env.WAVE_SALES_TAX_ID }] } : {})
          });
        }
        if (pick(addonsTotal) > 0) {
          waveItems.push({
            productId: env.WAVE_PRODUCT_ID_ADDON,
            description: 'Add-ons',
            unitPrice: String(pick(addonsTotal).toFixed(2)),
            quantity: 1,
            ...(taxMode === 'native' && env.WAVE_SALES_TAX_ID ? { taxes: [{ salesTaxId: env.WAVE_SALES_TAX_ID }] } : {})
          });
        }
        if (discountLineAmount > 0) {
          waveItems.push({
            productId: env.WAVE_PRODUCT_ID_DISCOUNT || env.WAVE_PRODUCT_ID_ADDON,
            description: 'Discount',
            unitPrice: String((-discountLineAmount).toFixed(2)),
            quantity: 1
          });
        }
        if (taxMode === 'line' && taxLineAmount > 0) {
          waveItems.push({
            productId: env.WAVE_PRODUCT_ID_TAX,
            description: `Sales Tax (${(taxRate * 100).toFixed(2)}%)`,
            unitPrice: String(pick(taxLineAmount).toFixed(2)),
            quantity: 1
          });
        }
      }

      const variables = {
        input: {
          businessId: businessIdB64,
          customerId: customerGid,
          currency,
          items: waveItems,
          // memo opcional:
          // memo: `Venue: ${venue||''}\nPhone: ${phone||''}\nDate: ${dateISO||''} ${startISO||''}\nHours: ${hours||''}\nNotes: ${notes||''}`
        }
      };

      if (dry) return json(res, 200, { ok: true, dryRun: true, variables });

      const data = await waveCall(env.WAVE_TOKEN, MUT_INVOICE_CREATE, variables);
      const result = data?.invoiceCreate;
      if (!result?.didSucceed) {
        return json(res, 400, { ok: false, error: 'invoiceCreate failed', inputErrors: result?.inputErrors || [] });
      }

      let invoice = result.invoice;

      if (env.WAVE_INVOICE_AUTO_APPROVE && invoice?.id) {
        try {
          const approve = await waveCall(env.WAVE_TOKEN, MUT_INVOICE_APPROVE, { input: { invoiceId: invoice.id } });
          if (approve?.invoiceApprove?.didSucceed) invoice.status = 'APPROVED';
        } catch (e) {
          console.warn('invoiceApprove warning:', e.message);
        }
      }

      return json(res, 200, { ok: true, invoice });
    }

    return json(res, 400, { ok: false, error: 'Invalid action.' });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message || 'Internal Error.' });
  }
}
