require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_KEY = process.env.GOOGLE_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── HEALTH CHECK ──
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    google: GOOGLE_KEY ? '✅ configured' : '❌ missing',
    anthropic: ANTHROPIC_KEY ? '✅ configured' : '❌ missing'
  });
});

// ── GEOCODE ──
app.get('/api/geocode', async (req, res) => {
  const { location } = req.query;
  if (!location) return res.status(400).json({ error: 'location required' });
  if (!GOOGLE_KEY) return res.status(500).json({ error: 'Google API key not configured in .env' });

  try {
    const r = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address: location, key: GOOGLE_KEY }
    });
    if (r.data.status !== 'OK') {
      return res.status(400).json({ error: `Location not found: ${r.data.status}` });
    }
    res.json(r.data.results[0].geometry.location);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PLACES SEARCH ──
app.get('/api/places', async (req, res) => {
  const { lat, lng, radius, keyword } = req.query;
  if (!lat || !lng || !keyword) return res.status(400).json({ error: 'lat, lng, keyword required' });
  if (!GOOGLE_KEY) return res.status(500).json({ error: 'Google API key not configured in .env' });

  try {
    const r = await axios.get('https://maps.googleapis.com/maps/api/place/nearbysearch/json', {
      params: { location: `${lat},${lng}`, radius: radius || 5000, keyword, key: GOOGLE_KEY }
    });
    if (r.data.status === 'REQUEST_DENIED') {
      return res.status(403).json({ error: 'Google API key denied. Check Places API is enabled and billing is active.' });
    }
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PLACE DETAILS ──
app.get('/api/place-details', async (req, res) => {
  const { place_id } = req.query;
  if (!place_id) return res.status(400).json({ error: 'place_id required' });
  if (!GOOGLE_KEY) return res.status(500).json({ error: 'Google API key not configured in .env' });

  try {
    const r = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
      params: {
        place_id,
        fields: 'name,formatted_phone_number,website,opening_hours,formatted_address,rating,user_ratings_total,types',
        key: GOOGLE_KEY
      }
    });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI ENRICHMENT ──
app.post('/api/enrich', async (req, res) => {
  const { url, bizName } = req.body;
  if (!url || !bizName) return res.status(400).json({ error: 'url and bizName required' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Anthropic API key not configured in .env' });

  try {
    const prompt = `You are a business contact extractor.

Search for and visit the website "${url}" for the business "${bizName}" and extract all contact information you can find.

Return ONLY a valid JSON object with no other text, preamble, or markdown:
{
  "emails": ["email@domain.com"],
  "owner_name": "Full Name or null",
  "facebook": "https://facebook.com/page or null",
  "instagram": "https://instagram.com/handle or null",
  "twitter": "https://twitter.com/handle or null",
  "linkedin": "https://linkedin.com/company/... or null",
  "tiktok": "https://tiktok.com/@handle or null",
  "description": "One sentence about what this business does"
}

Rules: Only include emails actually found. Set missing fields to null. Return ONLY the JSON.`;

    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    });

    const text = r.data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'Could not parse AI response' });

    res.json(JSON.parse(match[0]));
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    res.status(500).json({ error: msg });
  }
});

// ── SERVE FRONTEND ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n✅ LeadHarvest running at http://localhost:${PORT}`);
  console.log(`   Google API: ${GOOGLE_KEY ? '✅ configured' : '❌ MISSING — add to .env'}`);
  console.log(`   Anthropic:  ${ANTHROPIC_KEY ? '✅ configured' : '❌ MISSING — add to .env'}\n`);
});
