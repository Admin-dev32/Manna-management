// /api/generate-link.js
export const config = { runtime: 'nodejs' };

import Stripe from 'stripe';
import { withCORS } from './_cors.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const FULL_FLAT_OFF = 20;

function pkgToHours(pkg){
  if (pkg === '50-150-5h') return 2;
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2;
}
const asStr = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(x => String(x)).join(','); // arrays → "a,b,c"
  if (typeof v === 'object') return JSON.stringify(v);          // avoid nested structures
  return String(v);
};

export default async function handler(req, res){
  // CORS + preflight
  if (withCORS(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ ok:false, error:'Method not allowed' });
  }

  try{
    if(!process.env.STRIPE_SECRET_KEY){
      return res.status(500).json({ ok:false, error:'Missing STRIPE_SECRET_KEY' });
    }

    const pb = req.body || {};
    const { pkg, mainBar, dateISO, startISO } = pb;
    if(!pkg || !mainBar || !dateISO || !startISO){
      return res.status(400).json({ ok:false, error:'Missing booking basics (pkg, mainBar, dateISO, startISO)' });
    }

    const total   = Number(pb.total   || 0);
    const deposit = Number(pb.deposit || 0);
    const payMode = pb.payMode || 'deposit';
    const dueNow  = payMode === 'full'
      ? Math.max(total - FULL_FLAT_OFF, 0)
      : Math.max(deposit, 0);

    const hours = Number(pb.hours || 0) || pkgToHours(pkg);
    const name = `Manna — ${mainBar} (${pkg}) — Manager Link`;

    // ✅ String-only, flattened metadata for Stripe
    const md = {
      pkg: asStr(pkg),
      mainBar: asStr(mainBar),
      payMode: asStr(payMode),

      secondEnabled: asStr(!!pb.secondEnabled),
      secondBar: asStr(pb.secondBar),
      secondSize: asStr(pb.secondSize),

      fountainEnabled: asStr(!!pb.fountainEnabled),
      fountainSize: asStr(pb.fountainSize),
      fountainType: asStr(pb.fountainType),

      addons: asStr(pb.addons),            // array → "a,b,c"
      discountApplied: asStr(pb.discountApplied),
      total: asStr(total),
      dueNow: asStr(dueNow),

      dateISO: asStr(dateISO),
      startISO: asStr(startISO),
      hours: asStr(hours),

      fullName: asStr(pb.fullName || pb.name),
      email: asStr(pb.email),
      phone: asStr(pb.phone),
      venue: asStr(pb.venue),
      setup: asStr(pb.setup),
      power: asStr(pb.power),

      managerCreated: 'true'
    };

    const BASE_URL = (process.env.PUBLIC_URL || 'https://mannasnackbars.com').replace(/\/+$/, '');
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name },
          unit_amount: Math.round(dueNow * 100)
        },
        quantity: 1
      }],
      success_url: `${BASE_URL}/`,
      cancel_url: `${BASE_URL}/`,
      metadata: md
    });

    return res.status(200).json({ ok:true, url: session.url });
  }catch(e){
    console.error('generate-link error', e);
    return res.status(500).json({ ok:false, error:e.message });
  }
}
