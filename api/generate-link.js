// /api/generate-link.js
export const config = { runtime: 'nodejs' };
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const pb = req.body || {};
    const BASE_URL = process.env.PUBLIC_URL || 'https://mannasnackbars.com';

    const total = parseFloat(pb.total || 0);
    const deposit = parseFloat(pb.deposit || total * 0.25);
    const dueNow = Math.max(deposit, 0);

    const name = `Manna — ${pb.mainBar} (${pb.pkg}) — Manual Manager Link`;

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
        ...pb,
        managerCreated: 'true',
        dueNow,
        total
      }
    });

    res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error('generate-link error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
}
