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
  // console.log('[oauth/start] redirecting to:', zohoLoginURL);
  res.redirect(zohoLoginURL);
});

app.get('/oauth/callback', async (req, res) => {
  const { code, error, state } = req.query;

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


    const { access_token, refresh_token, error: tokenError } = tokenRes.data;

    if (tokenError || !access_token) {
      console.error('[oauth/callback] Token exchange failed:', tokenRes.data);
      return res.redirect('/?error=token_exchange_failed');
    }

    const orgRes = await axios.get(
      `${process.env.ZOHO_API_DOMAIN}/organizations`,
      { headers: { Authorization: `Zoho-oauthtoken ${access_token}` } }
    );

    const org_id =
      orgRes.data.organizations && orgRes.data.organizations.length > 1
        ? orgRes.data.organizations[1].organization_id
        : null;


    const tokens = {
      access_token,
      refresh_token: refresh_token || null,
      organization_id: org_id,
      last_synced: new Date().toISOString()
    };

    req.session.zohoTokens = tokens;


    const sessionSize = JSON.stringify(req.session).length;
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

  // console.log('[refreshToken] refreshing access token...');

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

  // console.log('[refreshToken] response:', JSON.stringify(response.data));

  if (!response.data.access_token) {
    throw new Error('Refresh token response missing access_token: ' + JSON.stringify(response.data));
  }

  // FIX: Reassign entire object so cookie-session detects the change
  req.session.zohoTokens = {
    ...t,
    access_token: response.data.access_token,
    last_synced: new Date().toISOString()
  };

  // console.log('[refreshToken] new token saved');
  return response.data.access_token;
}

// Helper to make authenticated Zoho API calls
async function zohoGet(req, endpoint, params = {}) {
  const t = getTokens(req);
  if (!t || !t.access_token) throw new Error('No access token in session');

  const url = `${process.env.ZOHO_API_DOMAIN}${endpoint}`;
  const allParams = { organization_id: t.organization_id, ...params };

  // console.log(`[zohoGet] GET ${url}`, allParams);

  try {
    const response = await axios.get(url, {
      headers: { Authorization: `Zoho-oauthtoken ${t.access_token}` },
      params: allParams
    });
    return response.data;
  } catch (err) {
    if (err.response?.status === 401) {
      // console.log('[zohoGet] 401 - attempting token refresh...');
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


// ============================================
// BILLS CACHE
// ============================================
const billsCache = {
  data: [],           // stored bills
  dateRange: null,    // { from, to }
  lastFetched: null,  // timestamp
  ttl: 10000 * 60 * 1000 // 10000 minutes
};

function isCacheValid(from, to) {
  if (!billsCache.lastFetched || !billsCache.data.length) return false;

  const now = Date.now();
  const isExpired = (now - billsCache.lastFetched) > billsCache.ttl;
  if (isExpired) return false;

  // Check if same date range
  const isSameRange = billsCache.dateRange?.from === from &&
    billsCache.dateRange?.to === to;

  return isSameRange;
}

function clearBillsCache() {
  billsCache.data = [];
  billsCache.dateRange = null;
  billsCache.lastFetched = null;
  console.log('🗑️ Bills cache cleared');
}

// ============================================
// FETCH & ENRICH BILLS
// ============================================
async function fetchAndEnrichBills(req, params, date_from, date_to) {
  let allBills = [];
  let page = 1;
  let hasMorePages = true;

  // Step 1: Fetch all bills from list API
  while (hasMorePages) {
    const pageParams = { ...params, page, per_page: 200 };
    const data = await zohoGet(req, '/bills', pageParams);
    const bills = data.bills || [];
    allBills = allBills.concat(bills);

    hasMorePages = data.page_context?.has_more_page || false;
    page++;

    if (allBills.length >= 1000 || page > 50) {
      console.log(`⚠️ Stopped at ${allBills.length} bills`);
      break;
    }
  }

  console.log(`📦 Fetched ${allBills.length} bills from Zoho`);

  // Step 2: Enrich with full details (for custom fields)
  if (allBills.length > 0 && allBills.length <= 500) {
    console.log(`🔍 Enriching ${allBills.length} bills with details...`);

    const batchSize = 10;
    const enrichedBills = [];

    for (let i = 0; i < allBills.length; i += batchSize) {
      const batch = allBills.slice(i, i + batchSize);

      const detailPromises = batch.map(async (bill) => {
        try {
          const detail = await zohoGet(req, `/bills/${bill.bill_id}`, {});
          const fullBill = detail.bill || {};
          return {
            ...bill,
            cf_expense_related_month: fullBill.custom_field_hash?.cf_expense_related_month || '',
            custom_field_hash: fullBill.custom_field_hash || {},
            line_items: fullBill.line_items || [],
            reporting_tags: fullBill.line_items?.flatMap(item => item.tags || []) || []
          };
        } catch (err) {
          console.error(`❌ Failed to enrich bill ${bill.bill_id}:`, err.message);
          return bill;
        }
      });

      const batchResults = await Promise.all(detailPromises);
      enrichedBills.push(...batchResults);

      console.log(`   ✅ Enriched ${Math.min(i + batchSize, allBills.length)}/${allBills.length}`);

      if (i + batchSize < allBills.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    allBills = enrichedBills;
  }

  // Step 3: Store in cache
  billsCache.data = allBills;
  billsCache.dateRange = { from: date_from, to: date_to };
  billsCache.lastFetched = Date.now();

  console.log(`💾 Cached ${allBills.length} bills`);
  return allBills;
}

// ============================================
// MAIN BILLS ROUTE
// ============================================
app.get('/api/bills', requireLogin, async (req, res) => {
  const t = getTokens(req);
  if (!t || !t.access_token) {
    return res.status(400).json({ error: 'Zoho not connected' });
  }

  try {
    let {
      status,
      date_from,
      date_to,
      due_date_from,
      due_date_to,
      vendor_id,
      vendor_name,
      total_min,
      total_max,
      cf_expense_related_month,
      cf_nature_of_expense,
      bill_number,
      reference_number,
      search_text,
      sort_column,
      sort_order
    } = req.query;

    // ✅ If NO date filter → default to last 1 month
    const hasDateFilter = date_from || date_to;
    if (!hasDateFilter) {
      const now = new Date();
      const oneMonthAgo = new Date(now);
      oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
      date_from = oneMonthAgo.toISOString().split('T')[0];
      date_to = now.toISOString().split('T')[0];
      console.log(`📅 Default: Last 1 month (${date_from} to ${date_to})`);
    }

    let allBills = [];

    // ✅ Check cache first
    if (isCacheValid(date_from, date_to)) {
      console.log(`⚡ Cache HIT - returning ${billsCache.data.length} cached bills`);
      allBills = billsCache.data;
    } else {
      console.log(`🔄 Cache MISS - fetching from Zoho...`);

      // Build base params for Zoho API
      const baseParams = {};
      if (date_from) baseParams.date_start = date_from;
      if (date_to) baseParams.date_end = date_to;
      if (due_date_from) baseParams.due_date_start = due_date_from;
      if (due_date_to) baseParams.due_date_end = due_date_to;
      if (sort_column) baseParams.sort_column = sort_column;
      if (sort_order) baseParams.sort_order = sort_order;

      // NOTE: Don't pass status/vendor etc to Zoho when caching
      // We filter those client-side so cache can be reused across filters

      allBills = await fetchAndEnrichBills(req, baseParams, date_from, date_to);
    }

    // ============================================
    // CLIENT-SIDE FILTERING (always applied)
    // ============================================
    let filteredBills = [...allBills];

    if (status && status !== 'all') {
      filteredBills = filteredBills.filter(b => b.status === status);
    }

    if (cf_expense_related_month) {
      filteredBills = filteredBills.filter(bill => {
        const val = bill.cf_expense_related_month
          || bill.custom_field_hash?.cf_expense_related_month
          || '';
        return val.toLowerCase().includes(cf_expense_related_month.toLowerCase());
      });
    }

    if (cf_nature_of_expense) {
      filteredBills = filteredBills.filter(bill => {
        const val = bill.cf_nature_of_expense
          || bill.custom_field_hash?.cf_nature_of_expense
          || '';
        return val.toLowerCase().includes(cf_nature_of_expense.toLowerCase());
      });
    }

    if (vendor_name) {
      filteredBills = filteredBills.filter(bill =>
        (bill.vendor_name || '').toLowerCase().includes(vendor_name.toLowerCase())
      );
    }

    if (vendor_id) {
      filteredBills = filteredBills.filter(bill => bill.vendor_id === vendor_id);
    }

    if (bill_number) {
      filteredBills = filteredBills.filter(bill =>
        (bill.bill_number || '').toLowerCase().includes(bill_number.toLowerCase())
      );
    }

    if (reference_number) {
      filteredBills = filteredBills.filter(bill =>
        (bill.reference_number || '').toLowerCase().includes(reference_number.toLowerCase())
      );
    }

    if (search_text) {
      const s = search_text.toLowerCase();
      filteredBills = filteredBills.filter(bill =>
        (bill.bill_number || '').toLowerCase().includes(s) ||
        (bill.vendor_name || '').toLowerCase().includes(s) ||
        (bill.reference_number || '').toLowerCase().includes(s)
      );
    }

    if (total_min) {
      filteredBills = filteredBills.filter(bill => parseFloat(bill.total) >= parseFloat(total_min));
    }

    if (total_max) {
      filteredBills = filteredBills.filter(bill => parseFloat(bill.total) <= parseFloat(total_max));
    }

    console.log(`✅ Filtered: ${filteredBills.length} / ${allBills.length}`);

    // Summary
    const summary = {
      paid: { count: 0, amount: 0 },
      pending: { count: 0, amount: 0 },
      overdue: { count: 0, amount: 0 },
      pending_approval: { count: 0, amount: 0 },
      draft: { count: 0, amount: 0 },
      total: { count: filteredBills.length, amount: 0 }
    };

    filteredBills.forEach(bill => {
      const amt = parseFloat(bill.total) || 0;
      summary.total.amount += amt;
      switch (bill.status) {
        case 'paid': summary.paid.count++; summary.paid.amount += amt; break;
        case 'overdue': summary.overdue.count++; summary.overdue.amount += amt; break;
        case 'pending_approval': summary.pending_approval.count++; summary.pending_approval.amount += amt; break;
        case 'draft': summary.draft.count++; summary.draft.amount += amt; break;
        default: summary.pending.count++; summary.pending.amount += amt; break;
      }
    });

    res.json({
      bills: filteredBills,
      summary,
      total_count: filteredBills.length,
      fetched_count: allBills.length,
      from_cache: isCacheValid(date_from, date_to),
      date_range: { from: date_from, to: date_to },
      is_default: !hasDateFilter,
      cache_expires_in: billsCache.lastFetched
        ? Math.max(0, Math.round((billsCache.ttl - (Date.now() - billsCache.lastFetched)) / 1000))
        : 0
    });

  } catch (err) {
    console.error('[bills] error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch bills', detail: err.message });
  }
});

// ============================================
// FORCE REFRESH CACHE
// ============================================
app.post('/api/bills/refresh', requireLogin, (req, res) => {
  clearBillsCache();
  res.json({ message: '✅ Cache cleared. Next request will fetch fresh data.' });
});

// ============================================
// CACHE STATUS
// ============================================
app.get('/api/bills/cache-status', requireLogin, (req, res) => {
  const now = Date.now();
  res.json({
    has_cache: billsCache.data.length > 0,
    cached_count: billsCache.data.length,
    date_range: billsCache.dateRange,
    last_fetched: billsCache.lastFetched
      ? new Date(billsCache.lastFetched).toISOString()
      : null,
    expires_in_seconds: billsCache.lastFetched
      ? Math.max(0, Math.round((billsCache.ttl - (now - billsCache.lastFetched)) / 1000))
      : 0,
    is_valid: billsCache.data.length > 0 && billsCache.lastFetched
      ? (now - billsCache.lastFetched) < billsCache.ttl
      : false
  });
});






// Force refresh cache endpoint
app.post('/api/bills/refresh-cache', requireLogin, async (req, res) => {
  billsCache.lastFetched = null;
  billsCache.data = [];
  res.json({ message: 'Cache cleared. Next request will fetch fresh data.' });
});

// ✅ NEW route - Get single bill with ALL details
app.get('/api/bills/:billId', requireLogin, async (req, res) => {
  const t = getTokens(req);
  if (!t || !t.access_token) {
    return res.status(400).json({ error: 'Zoho not connected' });
  }

  try {
    const { billId } = req.params;
    const data = await zohoGet(req, `/bills/${billId}`, {});
    const bill = data.bill;

    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    res.json({ bill });
  } catch (err) {
    console.error('[bill-detail] error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch bill details', detail: err.message });
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