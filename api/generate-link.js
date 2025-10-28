// /api/generate-link.js
export const config = { runtime: 'nodejs' };

import Stripe from 'stripe';
import { withCORS } from './_cors.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const FULL_FLAT_OFF = 20; // pay-in-full descuento fijo

export default async function handler(req, res){
  // CORS + preflight
  if (withCORS(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ ok:false, error:'Method not allowed' });
  }

  try{
    const pb = req.body || {};
    const BASE_URL = process.env.PUBLIC_URL || 'https://mannasnackbars.com';

    // Estos valores VIENEN ya calculados desde tu HTML (subtotal -> discount -> total -> deposit)
    const total    = Number(pb.total || 0);
    const deposit  = Number(pb.deposit || 0);
    const payMode  = pb.payMode || 'deposit';              // 'deposit' | 'full'
    const dueNow   = payMode === 'full' ? Math.max(0, total - FULL_FLAT_OFF) : Math.max(0, deposit);

    // Validaciones mínimas
    if(!pb.pkg || !pb.mainBar || !pb.dateISO || !pb.startISO){
      return res.status(400).json({ ok:false, error:'Missing booking basics (pkg, mainBar, dateISO, startISO)' });
    }
    if(!process.env.STRIPE_SECRET_KEY){
      return res.status(500).json({ ok:false, error:'Missing STRIPE_SECRET_KEY env var' });
    }

    const name = `Manna — ${pb.mainBar} (${pb.pkg}) — Manager Link`;

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
      metadata: {
        ...pb,                         // pkg, bars, addons, totals, etc.
        managerCreated: 'true',
        dueNow,
        total
      }
    });

    return res.status(200).json({ ok:true, url: session.url });
  }catch(e){
    console.error('generate-link error', e);
    return res.status(500).json({ ok:false, error:e.message });
  }
}
