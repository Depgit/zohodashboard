// ============================================
// ZOHO BOOKS DASHBOARD - MAIN SERVER
// ============================================
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Middleware ----
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'zoho-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// ---- In-memory token store (simple & beginner-friendly) ----
let zohoTokens = {
  access_token: null,
  refresh_token: null,
  organization_id: null,
  last_synced: null
};

// ---- Auth Middleware ----
function requireLogin(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  res.status(401).json({ error: 'Not logged in' });
}

// ============================================
// DASHBOARD LOGIN ROUTES
// ============================================

// Login
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (
    email === process.env.ADMIN_EMAIL &&
    password === process.env.ADMIN_PASSWORD
  ) {
    req.session.loggedIn = true;
    req.session.email = email;
    res.json({ success: true, email });
  } else {
    res.status(401).json({ error: 'Invalid email or password' });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Check session
app.get('/api/session', (req, res) => {
  if (req.session && req.session.loggedIn) {
    res.json({
      loggedIn: true,
      email: req.session.email,
      zohoConnected: !!zohoTokens.access_token,
      lastSynced: zohoTokens.last_synced
    });
  } else {
    res.json({ loggedIn: false });
  }
});

// ============================================
// ZOHO OAUTH ROUTES
// ============================================

// Step 1: Redirect user to Zoho login page
app.get('/oauth/start', requireLogin, (req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.ZOHO_CLIENT_ID,
    scope: 'ZohoBooks.fullaccess.all',
    redirect_uri: process.env.ZOHO_REDIRECT_URI,
    access_type: 'offline',
    prompt: 'consent'
  });
  const zohoLoginURL = `${process.env.ZOHO_DOMAIN}/oauth/v2/auth?${params}`;
  res.redirect(zohoLoginURL);
});

// Step 2: Zoho redirects back here with a code
app.get('/oauth/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect('/?error=zoho_denied');
  }

  if (!code) {
    return res.redirect('/?error=no_code');
  }

  try {
    // Exchange code for tokens
    const tokenRes = await axios.post(`${process.env.ZOHO_DOMAIN}/oauth/v2/token`, null, {
      params: {
        code,
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        redirect_uri: process.env.ZOHO_REDIRECT_URI,
        grant_type: 'authorization_code'
      }
    });

    const { access_token, refresh_token } = tokenRes.data;
    zohoTokens.access_token = access_token;
    zohoTokens.refresh_token = refresh_token;

    // Fetch organization ID
    const orgRes = await axios.get(`${process.env.ZOHO_API_DOMAIN}/organizations`, {
      headers: { Authorization: `Zoho-oauthtoken ${access_token}` }
    });

    if (orgRes.data.organizations && orgRes.data.organizations.length > 0) {
      zohoTokens.organization_id = orgRes.data.organizations[0].organization_id;
    }

    zohoTokens.last_synced = new Date().toISOString();
    req.session.zohoTokens = {
      access_token: tokenRes.data.access_token,
      refresh_token: tokenRes.data.refresh_token,
      organization_id: orgRes.data.organizations[0].organization_id,
      last_synced: new Date().toISOString()
    };
    res.redirect('/?zoho=connected');
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// ============================================
// TOKEN REFRESH HELPER
// ============================================
async function refreshAccessToken() {
  if (!zohoTokens.refresh_token) throw new Error('No refresh token');

  const res = await axios.post(`${process.env.ZOHO_DOMAIN}/oauth/v2/token`, null, {
    params: {
      refresh_token: zohoTokens.refresh_token,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token'
    }
  });

  zohoTokens.access_token = res.data.access_token;
  return zohoTokens.access_token;
}

// Helper to make authenticated Zoho API calls (auto-refreshes token)
async function zohoGet(endpoint, params = {}) {
  const url = `${process.env.ZOHO_API_DOMAIN}${endpoint}`;
  const allParams = { organization_id: zohoTokens.organization_id, ...params };

  try {
    const res = await axios.get(url, {
      headers: { Authorization: `Zoho-oauthtoken ${zohoTokens.access_token}` },
      params: allParams
    });
    return res.data;
  } catch (err) {
    if (err.response?.status === 401) {
      // Token expired - refresh and retry
      await refreshAccessToken();
      const res = await axios.get(url, {
        headers: { Authorization: `Zoho-oauthtoken ${zohoTokens.access_token}` },
        params: allParams
      });
      return res.data;
    }
    throw err;
  }
}

// ============================================
// ZOHO DATA ROUTES
// ============================================

// Sync status
app.get('/api/zoho/status', requireLogin, (req, res) => {
  res.json({
    connected: !!zohoTokens.access_token,
    organization_id: zohoTokens.organization_id,
    last_synced: zohoTokens.last_synced
  });
});

// Manual sync trigger
app.post('/api/zoho/sync', requireLogin, async (req, res) => {
  if (!zohoTokens.access_token) {
    return res.status(400).json({ error: 'Zoho not connected. Please click Connect Zoho first.' });
  }
  try {
    await refreshAccessToken();
    zohoTokens.last_synced = new Date().toISOString();
    res.json({ success: true, last_synced: zohoTokens.last_synced });
  } catch (err) {
    res.status(500).json({ error: 'Sync failed. Try reconnecting Zoho.' });
  }
});

// Disconnect Zoho
app.post('/api/zoho/disconnect', requireLogin, (req, res) => {
  zohoTokens = { access_token: null, refresh_token: null, organization_id: null, last_synced: null };
  res.json({ success: true });
});

// ---- INVOICES ----
app.get('/api/invoices', requireLogin, async (req, res) => {
  if (!zohoTokens.access_token) {
    return res.status(400).json({ error: 'Zoho not connected' });
  }

  try {
    const { status, date_from, date_to, page = 1 } = req.query;
    const params = { page, per_page: 50 };
    if (status && status !== 'all') params.status = status;
    if (date_from) params.date_start = date_from;
    if (date_to) params.date_end = date_to;

    const data = await zohoGet('/invoices', params);

    // Build summary
    const invoices = data.invoices || [];
    const summary = {
      paid: { count: 0, amount: 0 },
      pending: { count: 0, amount: 0 },
      overdue: { count: 0, amount: 0 },
      total: { count: invoices.length, amount: 0 }
    };

    invoices.forEach(inv => {
      const amt = parseFloat(inv.total) || 0;
      summary.total.amount += amt;
      if (inv.status === 'paid') { summary.paid.count++; summary.paid.amount += amt; }
      else if (inv.status === 'overdue') { summary.overdue.count++; summary.overdue.amount += amt; }
      else { summary.pending.count++; summary.pending.amount += amt; }
    });

    res.json({ invoices, summary, page_context: data.page_context });
  } catch (err) {
    console.error('Invoice error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// ---- EXPENSES ----
app.get('/api/expenses', requireLogin, async (req, res) => {
  if (!zohoTokens.access_token) {
    return res.status(400).json({ error: 'Zoho not connected' });
  }

  try {
    const data = await zohoGet('/expenses', { per_page: 200 });
    const expenses = data.expenses || [];

    // Monthly breakdown
    const monthly = {};
    const categories = {};
    let total = 0;

    expenses.forEach(exp => {
      const amt = parseFloat(exp.total) || 0;
      total += amt;

      // Monthly
      const date = exp.date || '';
      const month = date.substring(0, 7); // YYYY-MM
      if (month) {
        monthly[month] = (monthly[month] || 0) + amt;
      }

      // Category
      const cat = exp.account_name || 'Other';
      categories[cat] = (categories[cat] || 0) + amt;
    });

    const monthlyArray = Object.entries(monthly)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-6) // last 6 months
      .map(([month, amount]) => ({ month, amount: Math.round(amount * 100) / 100 }));

    const categoryArray = Object.entries(categories)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([category, amount]) => ({ category, amount: Math.round(amount * 100) / 100 }));

    res.json({
      total: Math.round(total * 100) / 100,
      count: expenses.length,
      monthly: monthlyArray,
      categories: categoryArray
    });
  } catch (err) {
    console.error('Expense error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch expenses' });
  }
});

// ============================================
// SERVE FRONTEND
// ============================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Start Server ----
app.listen(PORT, () => {
  console.log(`\n✅ Zoho Books Dashboard is running!`);
  console.log(`👉 Open your browser and go to: http://localhost:${PORT}`);
  console.log(`\n📧 Login with the email & password from your .env file`);
  console.log(`🔗 Then click "Connect Zoho" to link your Zoho Books account\n`);
});
