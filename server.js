require('dotenv').config();
const express = require('express');
const cookieSess = require('cookie-session');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Middleware ----
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(cookieSess({
  name: 'zoho_sess',
  keys: [process.env.SESSION_SECRET || 'zoho-secret-2024'],  // FIX: use keys[] not secret
  maxAge: 24 * 60 * 60 * 1000,
  secure: false,
  sameSite: 'lax',
  httpOnly: true
}));

// ---- CRITICAL FIX: Force cookie save on every response ----
// cookie-session only saves if session is "populated" — this ensures it always saves
app.use((req, res, next) => {
  req.session.nowInMinutes = Math.floor(Date.now() / 60e3);
  next();
});

// ---- Auth Middleware ----
function requireLogin(req, res, next) {
  // console.log('[requireLogin] session:', JSON.stringify(req.session));
  if (req.session && req.session.loggedIn) return next();
  res.status(401).json({ error: 'Not logged in' });
}

// ---- Token helpers ----
function getTokens(req) {
  return req.session.zohoTokens || {};
}

// ============================================
// DASHBOARD LOGIN ROUTES
// ============================================

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  // console.log('[login] attempt:', email);

  if (
    email === process.env.ADMIN_EMAIL &&
    password === process.env.ADMIN_PASSWORD
  ) {
    // FIX: Assign entire session object to trigger cookie-session save
    req.session.loggedIn = true;
    req.session.email = email;
    // Initialize empty tokens so the key exists
    if (!req.session.zohoTokens) {
      req.session.zohoTokens = null;
    }

    // console.log('[login] success, session set:', JSON.stringify(req.session));
    res.json({ success: true, email });
  } else {
    res.status(401).json({ error: 'Invalid email or password' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

app.get('/api/session', (req, res) => {
  // console.log('[session check] session:', JSON.stringify(req.session));
  if (req.session && req.session.loggedIn) {
    const t = getTokens(req);
    res.json({
      loggedIn: true,
      email: req.session.email,
      zohoConnected: !!(t && t.access_token),
      lastSynced: t ? t.last_synced : null
    });
  } else {
    res.json({ loggedIn: false });
  }
});

// ============================================
// ZOHO OAUTH ROUTES
// ============================================

app.get('/oauth/start', requireLogin, (req, res) => {
  // FIX: Store a state param to verify session on callback
  const state = Math.random().toString(36).substring(2);
  req.session.oauthState = state;

  // console.log('[oauth/start] starting OAuth, state:', state);
  // console.log('[oauth/start] session before redirect:', JSON.stringify(req.session));

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.ZOHO_CLIENT_ID,
    scope: 'ZohoBooks.fullaccess.all',
    redirect_uri: process.env.ZOHO_REDIRECT_URI,
    access_type: 'offline',
    prompt: 'consent',
    state  // include state for verification
  });

  const zohoLoginURL = `${process.env.ZOHO_DOMAIN}/oauth/v2/auth?${params}`;
  console.log('[oauth/start] redirecting to:', zohoLoginURL);
  res.redirect(zohoLoginURL);
});

app.get('/oauth/callback', async (req, res) => {
  const { code, error, state } = req.query;

  // console.log('[oauth/callback] query params:', req.query);
  // console.log('[oauth/callback] session at callback:', JSON.stringify(req.session));

  if (error) {
    console.error('[oauth/callback] Zoho returned error:', error);
    return res.redirect('/?error=zoho_denied');
  }
  if (!code) {
    console.error('[oauth/callback] No code returned');
    return res.redirect('/?error=no_code');
  }

  // FIX: Check if session still exists after Zoho redirect
  if (!req.session || !req.session.loggedIn) {
    console.error('[oauth/callback] SESSION LOST after Zoho redirect!');
    // Store code temporarily and ask user to login again
    return res.redirect('/?error=session_lost');
  }

  try {
    // console.log('[oauth/callback] exchanging code for tokens...');

    const tokenRes = await axios.post(
      `${process.env.ZOHO_DOMAIN}/oauth/v2/token`,
      null,
      {
        params: {
          code,
          client_id: process.env.ZOHO_CLIENT_ID,
          client_secret: process.env.ZOHO_CLIENT_SECRET,
          redirect_uri: process.env.ZOHO_REDIRECT_URI,
          grant_type: 'authorization_code'
        }
      }
    );

    // console.log('[oauth/callback] token response:', JSON.stringify(tokenRes.data));

    const { access_token, refresh_token, error: tokenError } = tokenRes.data;

    if (tokenError || !access_token) {
      console.error('[oauth/callback] Token exchange failed:', tokenRes.data);
      return res.redirect('/?error=token_exchange_failed');
    }

    const orgRes = await axios.get(
      `${process.env.ZOHO_API_DOMAIN}/organizations`,
      { headers: { Authorization: `Zoho-oauthtoken ${access_token}` } }
    );

    console.log('orgRes.data.organizations', orgRes.data.organizations[1]);
    const org_id =
      orgRes.data.organizations && orgRes.data.organizations.length > 1
        ? orgRes.data.organizations[1].organization_id
        : null;

    console.log('[oauth/callback] org_id:', org_id);

    // FIX: Explicitly reassign the whole zohoTokens object
    const tokens = {
      access_token,
      refresh_token: refresh_token || null,
      organization_id: org_id,
      last_synced: new Date().toISOString()
    };

    req.session.zohoTokens = tokens;

    // FIX: Verify it was actually stored
    // console.log('[oauth/callback] tokens saved to session:', JSON.stringify(req.session.zohoTokens));
    // console.log('[oauth/callback] full session after save:', JSON.stringify(req.session));

    // FIX: Check cookie size - warn if approaching limit
    const sessionSize = JSON.stringify(req.session).length;
    // console.log('[oauth/callback] session size in bytes:', sessionSize);
    if (sessionSize > 3000) {
      console.warn('[oauth/callback] WARNING: Session approaching 4KB cookie limit!', sessionSize, 'bytes');
    }

    res.redirect('/?zoho=connected');
  } catch (err) {
    console.error('[oauth/callback] Error:', err.response?.data || err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// ============================================
// TOKEN REFRESH HELPER
// ============================================
async function refreshAccessToken(req) {
  const t = getTokens(req);
  if (!t || !t.refresh_token) throw new Error('No refresh token available');

  console.log('[refreshToken] refreshing access token...');

  const response = await axios.post(
    `${process.env.ZOHO_DOMAIN}/oauth/v2/token`,
    null,
    {
      params: {
        refresh_token: t.refresh_token,
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        grant_type: 'refresh_token'
      }
    }
  );

  console.log('[refreshToken] response:', JSON.stringify(response.data));

  if (!response.data.access_token) {
    throw new Error('Refresh token response missing access_token: ' + JSON.stringify(response.data));
  }

  // FIX: Reassign entire object so cookie-session detects the change
  req.session.zohoTokens = {
    ...t,
    access_token: response.data.access_token,
    last_synced: new Date().toISOString()
  };

  console.log('[refreshToken] new token saved');
  return response.data.access_token;
}

// Helper to make authenticated Zoho API calls
async function zohoGet(req, endpoint, params = {}) {
  const t = getTokens(req);
  if (!t || !t.access_token) throw new Error('No access token in session');

  const url = `${process.env.ZOHO_API_DOMAIN}${endpoint}`;
  const allParams = { organization_id: t.organization_id, ...params };

  console.log(`[zohoGet] GET ${url}`, allParams);

  try {
    const response = await axios.get(url, {
      headers: { Authorization: `Zoho-oauthtoken ${t.access_token}` },
      params: allParams
    });
    return response.data;
  } catch (err) {
    if (err.response?.status === 401) {
      console.log('[zohoGet] 401 - attempting token refresh...');
      const newToken = await refreshAccessToken(req);
      const response = await axios.get(url, {
        headers: { Authorization: `Zoho-oauthtoken ${newToken}` },
        params: allParams
      });
      return response.data;
    }
    console.error('[zohoGet] Error:', err.response?.data || err.message);
    throw err;
  }
}

// ============================================
// ZOHO DATA ROUTES
// ============================================

app.get('/api/zoho/status', requireLogin, (req, res) => {
  const t = getTokens(req);
  console.log('[zoho/status] tokens:', t ? 'present' : 'missing');
  res.json({
    connected: !!(t && t.access_token),
    organization_id: t ? t.organization_id : null,
    last_synced: t ? t.last_synced : null
  });
});

app.post('/api/zoho/sync', requireLogin, async (req, res) => {
  const t = getTokens(req);
  if (!t || !t.access_token) {
    return res.status(400).json({ error: 'Zoho not connected. Please click Connect Zoho first.' });
  }
  try {
    await refreshAccessToken(req);
    res.json({ success: true, last_synced: req.session.zohoTokens.last_synced });
  } catch (err) {
    console.error('[sync] error:', err.message);
    res.status(500).json({ error: 'Sync failed. Try reconnecting Zoho.' });
  }
});

app.post('/api/zoho/disconnect', requireLogin, (req, res) => {
  req.session.zohoTokens = null;
  res.json({ success: true });
});

// ---- INVOICES ----
app.get('/api/invoices', requireLogin, async (req, res) => {
  const t = getTokens(req);
  console.log('[invoices] session tokens:', t ? 'present' : 'MISSING');

  if (!t || !t.access_token) {
    return res.status(400).json({
      error: 'Zoho not connected',
      debug: 'No access_token in session. Please reconnect Zoho.'
    });
  }

  try {
    const { status, date_from, date_to, page = 1 } = req.query;
    const params = { page, per_page: 50 };
    if (status && status !== 'all') params.status = status;
    if (date_from) params.date_start = date_from;
    if (date_to) params.date_end = date_to;

    const data = await zohoGet(req, '/invoices', params);
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
    console.error('[invoices] error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch invoices', detail: err.message });
  }
});

// ---- EXPENSES ----
app.get('/api/expenses', requireLogin, async (req, res) => {
  const t = getTokens(req);
  if (!t || !t.access_token) {
    return res.status(400).json({ error: 'Zoho not connected' });
  }

  try {
    const data = await zohoGet(req, '/expenses', { per_page: 200 });
    const expenses = data.expenses || [];

    const monthly = {};
    const categories = {};
    let total = 0;

    expenses.forEach(exp => {
      const amt = parseFloat(exp.total) || 0;
      total += amt;
      const month = (exp.date || '').substring(0, 7);
      if (month) monthly[month] = (monthly[month] || 0) + amt;
      const cat = exp.account_name || 'Other';
      categories[cat] = (categories[cat] || 0) + amt;
    });

    const monthlyArray = Object.entries(monthly)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-6)
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
    console.error('[expenses] error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch expenses' });
  }
});

// ============================================
// SERVE FRONTEND
// ============================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n✅ Server running at http://localhost:${PORT}`);
  });
}