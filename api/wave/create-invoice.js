// /api/wave/create-invoice.js
// ENV requeridas en Vercel:
// WAVE_TOKEN, WAVE_BUSINESS_ID, WAVE_CURRENCY=USD
// WAVE_PRODUCT_ID_SERVICE, WAVE_PRODUCT_ID_ADDON, WAVE_PRODUCT_ID_TAX
// TAX_RATE (ej. 0.0825) y TAX_APPLIES = 'after-discount' | 'before-discount'

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

const toMoneyStr = n => Number(n || 0).toFixed(2);

// Normaliza addons a [{name, price}]
function normalizeAddons(addons) {
  if (!addons) return [];
  if (Array.isArray(addons)) {
    return addons.map(a => {
      if (typeof a === 'string') return { name: a.trim(), price: 0 };
      if (typeof a === 'object' && a) {
        return { name: String(a.name || '').trim(), price: Number(a.price || 0) };
      }
      return null;
    }).filter(Boolean);
  }
  return String(addons).split(',').map(s => ({ name: s.trim(), price: 0 })).filter(a => a.name);
}

export default async function handler(req, res) {
  // CORS / OPTIONS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    return res.status(405).json({ ok:false, error:'Method not allowed' });
  }

  const token = process.env.WAVE_TOKEN;
  const businessId = process.env.WAVE_BUSINESS_ID;
  const currency = process.env.WAVE_CURRENCY || 'USD';
  const PID_SERVICE = process.env.WAVE_PRODUCT_ID_SERVICE;
  const PID_ADDON   = process.env.WAVE_PRODUCT_ID_ADDON;
  const PID_TAX     = process.env.WAVE_PRODUCT_ID_TAX;
  const TAX_RATE    = Number(process.env.TAX_RATE || 0);
  const TAX_MODE    = (process.env.TAX_APPLIES || 'after-discount').toLowerCase();

  if (!token || !businessId) {
    return res.status(500).json({ ok:false, error:'Wave not configured (WAVE_TOKEN / WAVE_BUSINESS_ID missing)' });
  }
  if (!PID_SERVICE || !PID_ADDON || !PID_TAX) {
    return res.status(500).json({ ok:false, error:'Missing product IDs. Set WAVE_PRODUCT_ID_SERVICE, WAVE_PRODUCT_ID_ADDON, WAVE_PRODUCT_ID_TAX' });
  }

  try {
    const {
      fullName, email, phone, venue,
      pkg, mainBar, secondEnabled, secondBar, secondSize,
      fountainEnabled, fountainSize, fountainType,
      addons = [],
      // descuento desde UI manager
      discountMode = 'amount',   // 'amount' | 'percent' | 'none'
      discountValue = 0,
      // Totales que ya calculas en UI (usados como base y memo)
      total = 0, deposit = 0, balance = 0,
      payMode = 'deposit', notes = '',
      dateISO, startISO, hours = 0
    } = req.body || {};

    // 1) Customer (busca por email; si no, lo crea)
    let customerId = null;
    if (email) {
      const found = await wave(Q_GET_CUSTOMER_BY_EMAIL, { businessId, email }, token);
      customerId = found?.business?.customers?.edges?.[0]?.node?.id || null;
    }
    if (!customerId) {
      const input = { businessId, name: fullName || 'Booking Client', email: email || undefined, phone: phone || undefined };
      const out = await wave(M_CREATE_CUSTOMER, { input }, token);
      if (!out.customerCreate?.didSucceed) {
        const errs = out.customerCreate?.inputErrors?.map(e => `${e.path?.join('.')}: ${e.message}`).join('; ') || 'failed';
        throw new Error('customerCreate: ' + errs);
      }
      customerId = out.customerCreate.customer.id;
    }

    // 2) Calcular impuesto como línea positiva (según TAX_RATE y TAX_APPLIES)
    const addonsNorm = normalizeAddons(addons);
    const subtotalBase = Number(total || 0) + addonsNorm.reduce((s,a)=>s + Number(a.price || 0), 0);

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

    // 3) Construir items
    const items = [];

    // Línea principal (solo el booking "total" sin add-ons)
    items.push({
      productId: PID_SERVICE,
      description: `Booking — ${mainBar || 'Service'}${pkg ? ` (${pkg})` : ''}`,
      quantity: 1,
      unitPrice: toMoneyStr(total)
    });

    // Add-ons
    addonsNorm.forEach(a => {
      items.push({
        productId: PID_ADDON,
        description: `Add-on — ${a.name}`,
        quantity: 1,
        unitPrice: toMoneyStr(a.price || 0)
      });
    });

    // Sales Tax como línea positiva
    if (TAX_RATE > 0 && taxAmount > 0) {
      const pctTxt = (TAX_RATE * 100).toFixed(2).replace(/\.00$/, '');
      items.push({
        productId: PID_TAX,
        description: `Sales Tax (${pctTxt}%)`,
        quantity: 1,
        unitPrice: toMoneyStr(taxAmount)
      });
    }

    // 4) Descuento nativo (sin línea negativa)
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

    const created = await wave(M_CREATE_INVOICE, { input: invoiceInput }, token);
    const invOut = created.invoiceCreate;
    if (!invOut?.didSucceed) {
      const errs = invOut?.inputErrors?.map(e => `${e.path?.join('.')}: ${e.message}`).join('; ') || 'failed';
      throw new Error('invoiceCreate: ' + errs);
    }
    const invoiceId = invOut.invoice?.id;
    const viewUrl = invOut.invoice?.viewUrl || null;
    const pdfUrl  = invOut.invoice?.pdfUrl || null;

    const approved = await wave(M_APPROVE, { input: { businessId, invoiceId } }, token);
    if (!approved?.invoiceApprove?.didSucceed) {
      const errs = approved?.invoiceApprove?.inputErrors?.map(e => `${e.path?.join('.')}: ${e.message}`).join('; ') || 'failed';
      throw new Error('invoiceApprove: ' + errs);
    }

    // Totales informativos
    const totals = {
      subtotalBase: toMoneyStr(subtotalBase),
      discount: toMoneyStr(discountAmt),
      taxableBase: toMoneyStr(taxableBase),
      tax: toMoneyStr(taxAmount),
      grand: toMoneyStr(taxableBase + taxAmount - discountAmt) // Wave recalcula internamente; esto es referencia
    };

    return res.json({ ok: true, invoiceId, viewUrl, pdfUrl, totals });

  } catch (err) {
    console.error('[wave/create-invoice] error:', err);
    return res.status(500).json({ ok:false, error: err.message });
  }
}
