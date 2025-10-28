// /api/wave.js  (o /api/wave/index.js en carpetas)
// Vercel Node.js Serverless Function

// =============== C O N F I G ==================
const WAVE_GQL = 'https://gql.waveapps.com/graphql/public';

// =============== U T I L S ====================
function json(res, code, body) {
  // CORS siempre
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.status(code).json(body);
}

function toBase64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}
function fromBase64(s) {
  return Buffer.from(s, 'base64').toString('utf8');
}
function looksLikeGlobalBusinessId(bid) {
  // Global ID Relay comienza por "Business:" → en base64 usualmente empieza con "QnVzaW5lc3M6"
  return typeof bid === 'string' && bid.startsWith('QnVzaW5lc3M6');
}
function ensureBusinessIdB64(envVal) {
  // Acepta UUID (a72505eb-...) o Global ID (Base64)
  if (!envVal) throw new Error('WAVE_BUSINESS_ID no definido');
  if (looksLikeGlobalBusinessId(envVal)) return envVal;
  // si parece UUID (contiene guiones), construir "Business:<uuid>" y b64
  if (envVal.includes('-')) return toBase64(`Business:${envVal}`);
  // fallback: si llega algo raro, lo dejamos tal cual
  return envVal;
}

function looksLikeGlobalCustomerId(id) {
  return typeof id === 'string' && id.startsWith('QnVzaW5lc3M6') && id.includes('O0N1c3RvbWVyO');
}
function normalizeCustomerId({ businessUuid, customerId }) {
  if (!customerId) return null; // se resolverá por email si aplica
  // ya es Global Relay ID?
  if (looksLikeGlobalCustomerId(customerId)) return customerId;
  // si es numérico "98000498", creamos Business:<uuid>;Customer:<num> → base64
  if (/^\d+$/.test(customerId)) {
    const raw = `Business:${businessUuid};Customer:${customerId}`;
    return toBase64(raw);
  }
  // si llega algo desconocido, lo retornamos tal cual (por si ya está bien)
  return customerId;
}

async function waveCall(token, query, variables) {
  const rsp = await fetch(WAVE_GQL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await rsp.json();
  if (json.errors) {
    // Devuelve el primer error legible
    const first = Array.isArray(json.errors) ? json.errors[0] : json.errors;
    throw new Error(`Wave error: ${JSON.stringify(first)}`);
  }
  return json.data;
}

// =============== G Q L   D O C S ================
const Q_BUSINESSES = `
query {
  businesses(page: 1, pageSize: 50) {
    edges {
      node { id name }
    }
  }
}`;

const Q_BUSINESS = `
query ($id: ID!) {
  business(id: $id) { id name }
}`;

const Q_PRODUCTS = `
query ($businessId: ID!) {
  business(id: $businessId) {
    id name
    products(page: 1, pageSize: 200) {
      edges { node { id name description } }
    }
  }
}`;

const Q_TAXES = `
query ($businessId: ID!) {
  business(id: $businessId) {
    id name
    salesTaxes(page: 1, pageSize: 100) {
      edges { node { id name rate } }
    }
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

// =============== C O R E  L O G I C ============
async function ensureCustomer({ token, businessIdB64, fullName, email }) {
  // estrategia simple: si no hay email, crea uno throwaway para no fallar
  const safeEmail = email && String(email).includes('@')
    ? email
    : `no-email+${Date.now()}@manna.local`;

  const vars = {
    input: {
      businessId: businessIdB64,
      name: fullName || 'Manna Booking',
      email: safeEmail,
    },
  };
  const data = await waveCall(token, MUT_CUSTOMER_CREATE, vars);
  if (!data?.customerCreate?.didSucceed) {
    const ie = data?.customerCreate?.inputErrors || [];
    throw new Error(`customerCreate failed: ${JSON.stringify(ie)}`);
  }
  return data.customerCreate.customer.id;
}

function pick(n, def = 0) {
  const v = parseFloat(n);
  return Number.isFinite(v) ? v : def;
}

function mapItemsToWave({ items, env, taxMode }) {
  // items: [{ kind: "service"|"addon"|"discount"|"tax", description, unitPrice, quantity }]
  // env: product ids + tax id opcional
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
      unitPrice: String(it.unitPrice), // Wave espera string decimal
      quantity: q,
    };

    // Impuesto nativo por renglón si hay WAVE_SALES_TAX_ID (solo si no es discount explícito negativo)
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

  // impuesto como línea separada (si NO usamos impuesto nativo por renglón)
  // TAX_APPLIES = 'before-discount' | 'after-discount'
  const baseTax = (taxApplies === 'before-discount')
    ? sub
    : Math.max(0, sub - discountLineAmount);
  const taxLineAmount = baseTax * pick(taxRate);

  return {
    discountLineAmount,
    taxLineAmount,
  };
}

// =============== H A N D L E R =================
export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    return res.status(204).end();
  }

  try {
    const action = (req.query.action || '').toString();

    const env = {
      WAVE_TOKEN: process.env.WAVE_TOKEN,
      WAVE_BUSINESS_ID: process.env.WAVE_BUSINESS_ID, // UUID o Base64
      WAVE_CURRENCY: process.env.WAVE_CURRENCY || 'USD',

      WAVE_PRODUCT_ID_SERVICE: process.env.WAVE_PRODUCT_ID_SERVICE,
      WAVE_PRODUCT_ID_ADDON: process.env.WAVE_PRODUCT_ID_ADDON,
      WAVE_PRODUCT_ID_DISCOUNT: process.env.WAVE_PRODUCT_ID_DISCOUNT, // opcional
      WAVE_PRODUCT_ID_TAX: process.env.WAVE_PRODUCT_ID_TAX,

      TAX_RATE: process.env.TAX_RATE, // ej. 0.0825
      TAX_APPLIES: process.env.TAX_APPLIES || 'after-discount', // 'before-discount'|'after-discount'
      WAVE_SALES_TAX_ID: process.env.WAVE_SALES_TAX_ID, // opcional: usa impuesto nativo por renglón

      WAVE_INVOICE_AUTO_APPROVE: process.env.WAVE_INVOICE_AUTO_APPROVE === 'true',
    };

    if (req.method === 'GET' && !action) {
      // health básico
      return json(res, 200, { ok: true });
    }

    // ------- acciones utilitarias -------
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

    // ------- crear invoice -------
    if (action === 'create-invoice') {
      if (req.method !== 'POST') {
        return json(res, 405, { ok: false, error: 'Method not allowed' });
      }

      const businessUuid = env.WAVE_BUSINESS_ID.includes('-')
        ? env.WAVE_BUSINESS_ID
        : fromBase64(env.WAVE_BUSINESS_ID).split(':')[1]; // "Business:<uuid>"

      const businessIdB64 = ensureBusinessIdB64(env.WAVE_BUSINESS_ID);

      const {
        // cliente
        fullName, email, customerId,

        // líneas (opción preferida: mandar items con price por renglón)
        items = [],

        // alternativa: mandar resumen y que el server derive líneas
        pkgTotal, addonsTotal, discountMode, discountValue,

        // impuestos
        currency = env.WAVE_CURRENCY || 'USD',

        // metadata (opcional)
        venue, phone, dateISO, startISO, hours, notes,

        // control interno UI
        total, deposit, balance, payMode,

        // dry-run opcional
        dry
      } = (req.body || {});

      // Resolución de cliente:
      let customerGid = normalizeCustomerId({ businessUuid, customerId });
      if (!customerGid) {
        // find-or-create por email
        customerGid = await ensureCustomer({
          token: env.WAVE_TOKEN,
          businessIdB64,
          fullName,
          email,
        });
      }

      // ¿usamos impuesto nativo o línea separada?
      const taxMode = env.WAVE_SALES_TAX_ID ? 'native' : 'line';
      const taxRate = env.TAX_RATE ? parseFloat(env.TAX_RATE) : 0;
      const taxApplies = env.TAX_APPLIES || 'after-discount';

      let waveItems = [];

      if (items.length) {
        // Manager manda líneas exactas (service/addon/discount/tax)
        waveItems = mapItemsToWave({ items, env, taxMode });
        // Si el impuesto es por línea separada (no nativo), NO añadimos aquí;
        // se agrega al final como línea "tax" con productId=WAVE_PRODUCT_ID_TAX.
        if (taxMode === 'line' && taxRate > 0) {
          // calculamos base a partir de las líneas positivas (service+addons), y descontamos las negativas (discount)
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
        // Modo derivado: server arma líneas desde pkgTotal/addonsTotal/discount
        const sub = pick(pkgTotal) + pick(addonsTotal);
        const { discountLineAmount, taxLineAmount } = computeDerivedLines({
          subtotal: sub,
          discountMode,
          discountValue,
          taxRate,
          taxApplies,
        });

        // base (service) — usa WAVE_PRODUCT_ID_SERVICE
        if (pick(pkgTotal) > 0) {
          waveItems.push({
            productId: env.WAVE_PRODUCT_ID_SERVICE,
            description: 'Service',
            unitPrice: String(pick(pkgTotal).toFixed(2)),
            quantity: 1,
            ...(taxMode === 'native' && env.WAVE_SALES_TAX_ID ? { taxes: [{ salesTaxId: env.WAVE_SALES_TAX_ID }] } : {})
          });
        }

        // addons (si vienen totalizados, lo cargamos como una línea ADDON)
        if (pick(addonsTotal) > 0) {
          waveItems.push({
            productId: env.WAVE_PRODUCT_ID_ADDON,
            description: 'Add-ons',
            unitPrice: String(pick(addonsTotal).toFixed(2)),
            quantity: 1,
            ...(taxMode === 'native' && env.WAVE_SALES_TAX_ID ? { taxes: [{ salesTaxId: env.WAVE_SALES_TAX_ID }] } : {})
          });
        }

        // descuento (línea negativa)
        if (discountLineAmount > 0) {
          waveItems.push({
            productId: env.WAVE_PRODUCT_ID_DISCOUNT || env.WAVE_PRODUCT_ID_ADDON,
            description: 'Discount',
            unitPrice: String((-discountLineAmount).toFixed(2)),
            quantity: 1
          });
        }

        // impuesto como línea separada (si no usamos tax nativo)
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
          // Puedes agregar memo/notes si quieres concatenar metadatos:
          // memo: `Venue: ${venue || ''}\nPhone: ${phone || ''}\nDate: ${dateISO || ''} ${startISO || ''}\nHours: ${hours || ''}\nNotes: ${notes || ''}`
        }
      };

      if (dry) {
        return json(res, 200, { ok: true, dryRun: true, variables });
      }

      // Crear invoice
      const data = await waveCall(env.WAVE_TOKEN, MUT_INVOICE_CREATE, variables);
      const result = data?.invoiceCreate;
      if (!result?.didSucceed) {
        return json(res, 400, { ok: false, error: 'invoiceCreate failed', inputErrors: result?.inputErrors || [] });
      }

      let invoice = result.invoice;

      // Auto-approve (opcional por ENV)
      if (env.WAVE_INVOICE_AUTO_APPROVE && invoice?.id) {
        try {
          const approve = await waveCall(env.WAVE_TOKEN, MUT_INVOICE_APPROVE, { input: { invoiceId: invoice.id } });
          if (approve?.invoiceApprove?.didSucceed) {
            invoice.status = 'APPROVED';
          }
        } catch (e) {
          // no rompas si approve falla; devuelve creada en DRAFT
          // eslint-disable-next-line no-console
          console.warn('invoiceApprove warning:', e.message);
        }
      }

      return json(res, 200, { ok: true, invoice });
    }

    // ------- ruta no reconocida -------
    return json(res, 400, { ok: false, error: 'Invalid action.' });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message || 'Internal Error.' });
  }
}
