// /api/wave/create-invoice.js
// Requiere en Vercel:
// WAVE_TOKEN, WAVE_BUSINESS_ID, WAVE_CURRENCY=USD
// TAX_RATE=0.0825 (ej.), TAX_APPLIES=after-discount|before-discount
// WAVE_PRODUCT_ID_SERVICE, WAVE_PRODUCT_ID_DISCOUNT, WAVE_PRODUCT_ID_TAX, WAVE_PRODUCT_ID_ADDON

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

// Queries / Mutations
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

const M_SEND = `
mutation Send($input: InvoiceSendInput!) {
  invoiceSend(input:$input) {
    didSucceed
    inputErrors { code message path }
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
  // CORS
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
  const TAX_RATE = Number(process.env.TAX_RATE || 0);
  const TAX_MODE = (process.env.TAX_APPLIES || 'after-discount').toLowerCase();

  const PID_SERVICE  = process.env.WAVE_PRODUCT_ID_SERVICE;
  const PID_DISCOUNT = process.env.WAVE_PRODUCT_ID_DISCOUNT;
  const PID_TAX      = process.env.WAVE_PRODUCT_ID_TAX;
  const PID_ADDON    = process.env.WAVE_PRODUCT_ID_ADDON;

  if (!token || !businessId) {
    return res.status(500).json({ ok:false, error:'Wave not configured (WAVE_TOKEN / WAVE_BUSINESS_ID missing)' });
  }
  if (!PID_SERVICE || !PID_DISCOUNT || !PID_TAX || !PID_ADDON) {
    return res.status(500).json({
      ok:false,
      error:'Missing product IDs. Set WAVE_PRODUCT_ID_SERVICE, WAVE_PRODUCT_ID_DISCOUNT, WAVE_PRODUCT_ID_TAX, WAVE_PRODUCT_ID_ADDON'
    });
  }

  try {
    const {
      fullName, email, phone, venue,
      pkg, mainBar, secondEnabled, secondBar, secondSize,
      fountainEnabled, fountainSize, fountainType,
      addons = [],
      discountApplied = 0,
      total = 0,
      deposit = 0, balance = 0,
      payMode = 'deposit', notes = '',
      dateISO, startISO, hours = 0
    } = req.body || {};

    // 1) Customer
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

    // 2) Totales
    const addonsNorm = normalizeAddons(addons);
    const subtotal = Number(total || 0);
    const discountAmt = Number(discountApplied || 0);

    const taxableBase = TAX_MODE === 'before-discount'
      ? Math.max(0, subtotal)
      : Math.max(0, subtotal - discountAmt);

    const taxAmount = +(taxableBase * TAX_RATE).toFixed(2);
    const grand = +(taxableBase + taxAmount).toFixed(2);

    // 3) Items con productId
    const items = [];

    // Booking total
    items.push({
      productId: PID_SERVICE,
      description: `Booking total — ${mainBar || 'Service'} (${pkg || ''})`,
      quantity: 1,
      unitPrice: toMoneyStr(subtotal)
    });

    if (discountAmt > 0) {
      items.push({
        productId: PID_DISCOUNT,
        description: 'Discount',
        quantity: 1,
        unitPrice: toMoneyStr(-Math.abs(discountAmt))
      });
    }

    if (TAX_RATE > 0) {
      const pctTxt = (TAX_RATE * 100).toFixed(2).replace(/\.00$/, '');
      items.push({
        productId: PID_TAX,
        description: `Sales Tax (${pctTxt}%)`,
        quantity: 1,
        unitPrice: toMoneyStr(taxAmount)
      });
    }

    // Add-ons
    addonsNorm.forEach(a => {
      items.push({
        productId: PID_ADDON,
        description: `Add-on — ${a.name}`,
        quantity: 1,
        unitPrice: toMoneyStr(a.price || 0)
      });
    });

    // 4) Crear y aprobar
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
        `Tax mode: ${TAX_MODE}`
      ].filter(Boolean).join('\n'),
      items: items.map(li => ({
        productId: li.productId,
        description: li.description,
        quantity: 1,
        unitPrice: String(li.unitPrice)
      }))
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

    // (Opcional) enviar
    // if (email) {
    //   const sent = await wave(M_SEND, { input: { businessId, invoiceId, to: [email], sendMethod: "ALL" } }, token);
    //   if (!sent?.invoiceSend?.didSucceed) {
    //     console.warn('invoiceSend failed', sent?.invoiceSend?.inputErrors);
    //   }
    // }

    return res.json({
      ok: true,
      invoiceId,
      viewUrl,
      pdfUrl,
      totals: {
        subtotal: toMoneyStr(subtotal),
        discount: toMoneyStr(discountAmt),
        taxableBase: toMoneyStr(taxableBase),
        tax: toMoneyStr(taxAmount),
        grand: toMoneyStr(grand)
      }
    });

  } catch (err) {
    console.error('[wave/create-invoice] error:', err);
    return res.status(500).json({ ok:false, error: err.message });
  }
}
