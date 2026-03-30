const express = require('express');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_KEY = process.env.GOOGLE_API_KEY;
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const JWT_SECRET = process.env.JWT_SECRET || 'leadharvest-v5-secret';
const BASE_URL = process.env.BASE_URL || 'https://lead-harvest-production.up.railway.app';

// ── PLANS ──
// credits = monthly export credits (deducted per row exported, not per search)
const PLANS = {
  free:       { leads: 10,   price: 0,   label: 'Free' },
  starter:    { leads: 500,  price: 29,  label: 'Starter' },
  pro:        { leads: 1000, price: 99,  label: 'Pro' },
  enterprise: { leads: 5000, price: 199, label: 'Enterprise' }
};

const STRIPE_PRICES = {
  starter:    process.env.STRIPE_PRICE_STARTER    || '',
  pro:        process.env.STRIPE_PRICE_PRO        || '',
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE || ''
};

app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DATABASE ──
const DB_PATH = path.join(__dirname, 'users.json');
function readDB() {
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ users: [] }));
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function writeDB(data) { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); }
function getUser(id) { return readDB().users.find(u => u.id === id); }
function updateUser(id, updates) {
  const db = readDB();
  const i = db.users.findIndex(u => u.id === id);
  if (i === -1) return null;
  db.users[i] = { ...db.users[i], ...updates };
  writeDB(db);
  return db.users[i];
}

// ── MONTHLY RESET ──
function checkReset(user) {
  const now = new Date();
  const last = new Date(user.lastReset || user.createdAt);
  const months = (now.getFullYear() - last.getFullYear()) * 12 + (now.getMonth() - last.getMonth());
  if (months >= 1) {
    const plan = PLANS[user.plan] || PLANS.free;
    return updateUser(user.id, { leadsUsed: 0, lastReset: now.toISOString() }) || user;
  }
  return user;
}

// ── AUTH MIDDLEWARE ──
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Session expired — please log in again' }); }
}

function safeUser(u) {
  const plan = PLANS[u.plan] || PLANS.free;
  const leadsUsed = u.leadsUsed || 0;
  const leadsRemaining = plan.leads === 0 ? 0 : Math.max(0, plan.leads - leadsUsed);
  return {
    id: u.id, name: u.name, email: u.email,
    plan: u.plan, planLabel: plan.label,
    exportCredits: plan.leads,        // total per month
    exportUsed: leadsUsed,            // used this month
    leadsAllowed: plan.leads,
    leadsUsed,
    leadsRemaining,
    savedLeads: u.savedLeads || []
  };
}

// ════════════════════════════
// AUTH ROUTES
// ════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const db = readDB();
  if (db.users.find(u => u.email === email.toLowerCase())) return res.status(400).json({ error: 'Account already exists with this email' });
  const user = {
    id: uuidv4(), name, email: email.toLowerCase(),
    password: await bcrypt.hash(password, 10),
    plan: 'free', leadsUsed: 0,
    createdAt: new Date().toISOString(),
    lastReset: new Date().toISOString(),
    savedLeads: [],
    stripeCustomerId: null, stripeSubscriptionId: null
  };
  db.users.push(user); writeDB(db);
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: safeUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const db = readDB();
  let user = db.users.find(u => u.email === email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'No account found with this email' });
  if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ error: 'Incorrect password' });
  user = checkReset(user);
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: safeUser(user) });
});

app.get('/api/auth/me', auth, (req, res) => {
  let user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user = checkReset(user);
  res.json(safeUser(user));
});

// ── SAVE LEAD ──
app.post('/api/leads/save', auth, (req, res) => {
  const { lead } = req.body;
  if (!lead) return res.status(400).json({ error: 'Lead data required' });
  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const saved = user.savedLeads || [];
  if (!saved.find(l => l.id === lead.id)) {
    saved.push({ ...lead, savedAt: new Date().toISOString() });
    updateUser(user.id, { savedLeads: saved });
  }
  res.json({ saved: saved.length });
});

app.delete('/api/leads/save/:id', auth, (req, res) => {
  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const saved = (user.savedLeads || []).filter(l => l.id !== req.params.id);
  updateUser(user.id, { savedLeads: saved });
  res.json({ saved: saved.length });
});

// ════════════════════════════
// SEARCH ROUTES
// ════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', google: GOOGLE_KEY ? '✅' : '❌', stripe: STRIPE_SECRET ? '✅' : '⚠️ not set' });
});

app.get('/api/geocode', auth, async (req, res) => {
  if (!GOOGLE_KEY) return res.status(500).json({ error: 'Google API key not configured' });
  try {
    const r = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address: req.query.location, key: GOOGLE_KEY }
    });
    if (r.data.status !== 'OK') return res.status(400).json({ error: 'Location not found — try a different town or postcode' });
    res.json(r.data.results[0].geometry.location);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PLACES — multi-point grid for maximum results ──
app.get('/api/places', auth, async (req, res) => {
  let user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user = checkReset(user);
  if (!GOOGLE_KEY) return res.status(500).json({ error: 'Google API key not configured' });
  // Searching is free — credits are only deducted on export

  try {
    const { lat, lng, radius, keyword } = req.query;
    const r = parseFloat(radius) || 5000;

    // Grid of search points for max results
    const gridSpacing = Math.min(r * 0.6, 3000);
    const gridSteps = Math.ceil(r / gridSpacing);
    const searchRadius = Math.round(gridSpacing * 1.3);
    const EARTH = 6371000;
    const latOff = (gridSpacing / EARTH) * (180 / Math.PI);
    const lngOff = latOff / Math.cos(parseFloat(lat) * Math.PI / 180);

    const points = [];
    for (let dy = -gridSteps; dy <= gridSteps; dy++) {
      for (let dx = -gridSteps; dx <= gridSteps; dx++) {
        const dist = Math.sqrt((dy * gridSpacing) ** 2 + (dx * gridSpacing) ** 2);
        if (dist <= r) points.push({ lat: parseFloat(lat) + dy * latOff, lng: parseFloat(lng) + dx * lngOff });
      }
    }

    // Limit grid points by plan — more points = more results
    const maxPts = user.plan === 'free' ? 1 : user.plan === 'starter' ? 5 : user.plan === 'pro' ? 15 : points.length;
    const searchPoints = points.slice(0, Math.min(maxPts, 25)); // cap at 25 to avoid timeout

    const seen = new Set();
    const allResults = [];

    for (let i = 0; i < searchPoints.length; i++) {
      const pt = searchPoints[i];
      let nextToken = null;
      for (let p = 0; p < 3; p++) {
        const params = { location: `${pt.lat},${pt.lng}`, radius: searchRadius, keyword, key: GOOGLE_KEY };
        if (nextToken) params.pagetoken = nextToken;
        if (p > 0) await new Promise(res => setTimeout(res, 2000));
        const resp = await axios.get('https://maps.googleapis.com/maps/api/place/nearbysearch/json', { params });
        if (resp.data.status === 'REQUEST_DENIED') return res.status(403).json({ error: 'Google API key denied — check Places API is enabled and billing is active' });
        if (!['OK', 'ZERO_RESULTS'].includes(resp.data.status)) break;
        for (const pl of (resp.data.results || [])) {
          if (!seen.has(pl.place_id)) { seen.add(pl.place_id); allResults.push(pl); }
        }
        nextToken = resp.data.next_page_token;
        if (!nextToken) break;
      }
      if (i < searchPoints.length - 1) await new Promise(res => setTimeout(res, 300));
    }

    res.json({ results: allResults, total: allResults.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/place-details', auth, async (req, res) => {
  if (!GOOGLE_KEY) return res.status(500).json({ error: 'Google API key not configured' });
  try {
    const r = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
      params: {
        place_id: req.query.place_id,
        fields: 'name,formatted_phone_number,website,opening_hours,formatted_address,rating,user_ratings_total,types,business_status',
        key: GOOGLE_KEY
      }
    });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════
// STRIPE
// ════════════════════════════
app.post('/api/stripe/create-checkout', auth, async (req, res) => {
  if (!STRIPE_SECRET) return res.status(500).json({ error: 'Stripe not configured — add STRIPE_SECRET_KEY to Railway variables' });
  const { plan } = req.body;
  const priceId = STRIPE_PRICES[plan];
  if (!priceId) return res.status(400).json({ error: `Stripe price not set for ${plan} plan` });
  try {
    const stripe = require('stripe')(STRIPE_SECRET);
    const user = getUser(req.user.id);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${BASE_URL}/app?upgraded=true&plan=${plan}`,
      cancel_url: `${BASE_URL}/app?cancelled=true`,
      customer_email: user.email,
      metadata: { userId: user.id, plan }
    });
    res.json({ url: session.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stripe/webhook', async (req, res) => {
  if (!STRIPE_SECRET || !STRIPE_WEBHOOK_SECRET) return res.sendStatus(200);
  const stripe = require('stripe')(STRIPE_SECRET);
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET); }
  catch (e) { return res.status(400).send(`Webhook error: ${e.message}`); }
  if (event.type === 'checkout.session.completed') {
    const { userId, plan } = event.data.object.metadata || {};
    if (userId && plan && PLANS[plan]) {
      updateUser(userId, { plan, leadsUsed: 0, lastReset: new Date().toISOString(), stripeCustomerId: event.data.object.customer, stripeSubscriptionId: event.data.object.subscription });
      console.log(`✅ Upgraded ${userId} to ${plan}`);
    }
  }
  if (event.type === 'customer.subscription.deleted') {
    const db = readDB();
    const user = db.users.find(u => u.stripeSubscriptionId === event.data.object.id);
    if (user) { updateUser(user.id, { plan: 'free', leadsUsed: 0 }); console.log(`⬇️ Downgraded ${user.email} to free`); }
  }
  res.sendStatus(200);
});

// ── EXPORT — deduct credits per row ──
app.post('/api/export', auth, (req, res) => {
  let user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user = checkReset(user);
  const { count } = req.body; // number of rows they want to export
  if (!count || count < 1) return res.status(400).json({ error: 'Invalid export count' });

  const plan = PLANS[user.plan] || PLANS.free;
  const remaining = plan.leads - (user.leadsUsed || 0);

  if (remaining <= 0) {
    return res.status(403).json({ error: 'No export credits remaining this month. Upgrade or wait for your monthly reset.', limitReached: true });
  }

  const canExport = Math.min(count, remaining);
  updateUser(user.id, { leadsUsed: (user.leadsUsed || 0) + canExport });

  res.json({
    approved: canExport,
    remaining: remaining - canExport,
    message: canExport < count ? `Only ${canExport} export credits remaining — exported ${canExport} of ${count} rows` : null
  });
});

// ── ADMIN ──
app.get('/api/admin/users', (req, res) => {
  if (req.headers['x-admin-secret'] !== (process.env.ADMIN_SECRET || 'admin123')) return res.status(403).json({ error: 'Forbidden' });
  const db = readDB();
  res.json(db.users.map(u => ({ id: u.id, name: u.name, email: u.email, plan: u.plan, leadsUsed: u.leadsUsed, savedLeads: (u.savedLeads||[]).length, createdAt: u.createdAt })));
});

// ── ROUTES ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pricing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ LeadHarvest v5 on port ${PORT}`);
  console.log(`   Google: ${GOOGLE_KEY ? '✅' : '❌ MISSING'}`);
  console.log(`   Stripe: ${STRIPE_SECRET ? '✅' : '⚠️  not set'}\n`);
});
