// /api/wave/create-invoice.js
export const config = { runtime: 'nodejs' };

const WAVE_API = 'https://gql.waveapps.com/graphql/public';

async function wave(q, variables, token) {
  const rsp = await fetch(WAVE_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ query: q, variables })
  });
  const json = await rsp.json();
  if (json.errors) throw new Error(json.errors.map(e=>e.message).join('; '));
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

const M_SEND = `
mutation Send($input: InvoiceSendInput!) {
  invoiceSend(input:$input) {
    didSucceed
    inputErrors { code message path }
  }
}`;

function money(amount) {
  // Wave usa Money como string decimal
  return Number(amount).toFixed(2);
}

export default async function handler(req, res) {
  // CORS básico para tu HTML en Hostinger
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' });

  const token = process.env.WAVE_TOKEN;
  const businessId = process.env.WAVE_BUSINESS_ID;
  const taxId = process.env.WAVE_TAX_ID || null;
  const currency = process.env.WAVE_CURRENCY || 'USD';
  if (!token || !businessId) {
    return res.status(500).json({ ok:false, error:'Wave not configured' });
  }

  try {
    const {
      // del manager payload
      fullName, email, phone, venue,
      pkg, mainBar, secondEnabled, secondBar, secondSize,
      fountainEnabled, fountainSize, fountainType,
      addons = [], discountApplied = 0,
      total = 0, deposit = 0, balance = 0,
      payMode = 'deposit', notes = '',
      dateISO, startISO, hours = 0
    } = req.body || {};

    // 1) Buscar o crear customer
    let customerId = null;
    if (email) {
      const data = await wave(Q_GET_CUSTOMER_BY_EMAIL, { businessId, email }, token);
      customerId = data?.business?.customers?.edges?.[0]?.node?.id || null;
    }
    if (!customerId) {
      const input = {
        businessId,
        name: fullName || 'Booking Client',
        email: email || undefined,
        phone: phone || undefined,
        address: undefined
      };
      const out = await wave(M_CREATE_CUSTOMER, { input }, token);
      if (!out.customerCreate?.didSucceed) {
        throw new Error('customerCreate: ' + (out.customerCreate?.inputErrors?.map(e=>e.message).join(', ') || 'failed'));
      }
      customerId = out.customerCreate.customer.id;
    }

    // 2) Construir renglones de invoice
    const items = [];

    // línea principal (paquete + main bar)
    items.push({
      description: `Event Booking — ${mainBar} (${pkg})`,
      quantity: 1,
      unitPrice: money(total - Number(discountApplied || 0) - addons.reduce((a,_,i)=>0,0)), // placeholder, ajustamos abajo
    });

    // second bar
    if (secondEnabled && secondBar && secondSize) {
      items.push({
        description: `Second Bar — ${secondBar} (${secondSize})`,
        quantity: 1,
        unitPrice: "0.00" // lo integramos en el total global via líneas separadas abajo
      });
    }

    // fountain
    if (fountainEnabled && fountainSize) {
      items.push({
        description: `Fountain — ${fountainType || 'standard'} (${fountainSize})`,
        quantity: 1,
        unitPrice: "0.00"
      });
    }

    // add-ons
    (addons || []).forEach((name) => {
      items.push({
        description: `Add-on — ${name}`,
        quantity: 1,
        unitPrice: "0.00"
      });
    });

    // Para reflejar montos exactos, mejor desglosar así:
    // - Línea "Booking total" con TOTAL
    // - Línea "Discount" con monto negativo (si aplica)
    // - Líneas Add-ons con sus montos si quieres (si los mandas con precio)
    // Como ya tienes total/discount en tu HTML, lo enviamos directo:
    const lineItems = [
      { description: `Booking total — ${mainBar} (${pkg})`, quantity: 1, unitPrice: money(total) }
    ];
    if (Number(discountApplied) > 0) {
      lineItems.push({ description: 'Discount', quantity: 1, unitPrice: money(-Math.abs(discountApplied)) });
    }
    // Si quieres mandar add-ons con precio individual: reemplaza arriba y pásalos desde el frontend con {name, price}

    // 3) Crear invoice (SAVED = no clásico; luego approve/send)
    const invoiceInput = {
      businessId,
      customerId,
      currency,
      status: "SAVED", // ver enum InvoiceCreateStatus
      title: "Event Booking",
      subhead: venue ? `Venue: ${venue}` : null,
      invoiceDate: new Date().toISOString().substring(0,10),
      dueDate: dateISO || new Date(Date.now()+7*864e5).toISOString().substring(0,10),
      memo: [
        notes ? `Notes: ${notes}` : null,
        dateISO ? `Event Date: ${dateISO}` : null,
        startISO ? `Start: ${startISO}` : null,
        hours ? `Service Hours: ${hours}` : null,
        `Pay mode: ${payMode}`,
        `Deposit: $${money(deposit)}`,
        `Balance: $${money(balance)}`
      ].filter(Boolean).join('\n'),
      items: lineItems.map(li => ({
        description: li.description,
        quantity: 1,
        unitPrice: money(li.unitPrice || li.unitPrice === 0 ? li.unitPrice : li.unitPrice) // string
      }))
    };

    // (impuestos opcionales)
    if (taxId) {
      // Wave aplica impuestos a nivel ítem, pero si quieres simple, lo dejas sin tax o
      // creas productos con defaultSalesTaxIds. Aquí lo omitimos por claridad.
    }

    const created = await wave(M_CREATE_INVOICE, { input: invoiceInput }, token);
    const invOut = created.invoiceCreate;
    if (!invOut?.didSucceed) {
      const errs = invOut?.inputErrors?.map(e => `${e.path?.join('.')}: ${e.message}`).join('; ');
      throw new Error('invoiceCreate: ' + (errs || 'failed'));
    }
    const invoiceId = invOut.invoice?.id;

    // 4) Aprobar (para numerarla) y opcionalmente enviar por email
    await wave(M_APPROVE, { input: { businessId, invoiceId } }, token);

    // Si quieres enviarla automáticamente, activa el bloque de abajo:
    // await wave(M_SEND, { input: {
    //   businessId, invoiceId,
    //   to: email ? [email] : [],
    //   sendMethod: "ALL" // o "EMAIL"
    // }}, token);

    return res.json({
      ok: true,
      invoiceId,
      viewUrl: invOut.invoice?.viewUrl || null
    });

  } catch (err) {
    console.error('[wave/create-invoice] error:', err);
    return res.status(500).json({ ok:false, error: err.message });
  }
}
