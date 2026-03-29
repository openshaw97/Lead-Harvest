# LeadHarvest v2 — Setup Guide

## Get live in 10 minutes

### Step 1 — Install Node.js
Download and install from: https://nodejs.org (click the LTS version)
After installing, open a terminal / command prompt and check it worked:
  node --version

### Step 2 — Add your API keys
Open the `.env` file in this folder and replace the placeholder values:
  GOOGLE_API_KEY=paste_your_google_key_here
  ANTHROPIC_API_KEY=paste_your_anthropic_key_here

### Step 3 — Install and run
Open a terminal IN this folder (or navigate to it with cd), then run:
  npm install
  node server.js

You should see:
  ✅ LeadHarvest running at http://localhost:3000

### Step 4 — Open the app
Go to http://localhost:3000 in your browser. Done!

---

## To put it online (so customers can use it)

### Option A — Railway (easiest, ~£5/month)
1. Go to https://railway.app and sign up
2. Click "New Project" → "Deploy from GitHub"
3. Push this folder to a GitHub repo first, then connect it
4. Add your environment variables in Railway's dashboard
5. Railway gives you a live URL automatically

### Option B — Render (free tier available)
1. Go to https://render.com
2. New → Web Service → connect your GitHub repo
3. Build command: npm install
4. Start command: node server.js
5. Add environment variables in the dashboard

### Option C — VPS (DigitalOcean/Hetzner, ~£4/month)
1. Get a Ubuntu VPS
2. Install Node.js: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
3. Upload this folder via SFTP
4. Run: npm install && node server.js
5. Use PM2 to keep it running: npm install -g pm2 && pm2 start server.js

---

## API Keys

### Google Places API (free tier)
1. Go to https://console.cloud.google.com
2. Create a project
3. Go to APIs & Services → Enable APIs
4. Enable: "Places API" AND "Geocoding API"
5. Go to Credentials → Create API Key
6. Copy the key into .env

### Anthropic API (AI enrichment)
1. Go to https://console.anthropic.com
2. Sign up and go to API Keys
3. Create a key and copy it into .env

---

## Adding Stripe payments
1. Go to https://stripe.com and create an account
2. Go to Products → create your subscription plans (£19, £49, £149)
3. Copy the Payment Link URLs
4. In public/index.html, find the handleUpgrade() function
5. Replace the toast line with: window.location.href = 'YOUR_STRIPE_PAYMENT_LINK'
