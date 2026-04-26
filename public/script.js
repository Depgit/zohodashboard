
window.addEventListener('DOMContentLoaded', async () => {
    // Handle OAuth callback messages
    const params = new URLSearchParams(window.location.search);
    if (params.get('zoho') === 'connected') {
        showToast('✅ Zoho Books connected successfully!', 'success');
        window.history.replaceState({}, '', '/');
    }
    if (params.get('error')) {
        const errs = {
            zoho_denied: 'Zoho login was cancelled.',
            oauth_failed: 'Zoho connection failed. Please try again.',
            no_code: 'OAuth error: no code received.'
        };
        showToast('❌ ' + (errs[params.get('error')] || 'Connection error'), 'error');
        window.history.replaceState({}, '', '/');
    }

    await checkSession();
});

// ============================================
// SESSION CHECK
// ============================================
async function checkSession() {
    try {
        const res = await fetch('/api/session');
        const data = await res.json();
        if (data.loggedIn) {
            showDashboard(data.email, data.zohoConnected, data.lastSynced);
        } else {
            showLogin();
        }
    } catch {
        showLogin();
    }
}

function showLogin() {
    document.getElementById('login-page').style.display = 'flex';
    document.getElementById('dashboard-page').style.display = 'none';
}

function showDashboard(email, zohoConnected, lastSynced) {
    document.getElementById('login-page').style.display = 'none';
    document.getElementById('dashboard-page').style.display = 'block';

    const initial = (email || 'A')[0].toUpperCase();
    document.getElementById('user-avatar').textContent = initial;

    isZohoConnected = zohoConnected;
    updateZohoUI(zohoConnected, lastSynced);

    if (zohoConnected) {
        loadInvoices();
        loadbills();
        loadExpenses();
    }
}

// ============================================
// AUTH
// ============================================
async function doLogin() {
    const btn = document.getElementById('login-btn');
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl = document.getElementById('login-error');

    if (!email || !password) {
        errEl.textContent = '⚠️ Please enter email and password';
        errEl.style.display = 'block';
        return;
    }

    btn.innerHTML = '<span class="spinner"></span> Signing in...';
    btn.disabled = true;
    errEl.style.display = 'none';

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();

        if (data.success) {
            await checkSession();
        } else {
            errEl.textContent = '❌ Invalid email or password';
            errEl.style.display = 'block';
        }
    } catch {
        errEl.textContent = '❌ Server error. Is the server running?';
        errEl.style.display = 'block';
    } finally {
        btn.innerHTML = 'Sign In →';
        btn.disabled = false;
    }
}

// Allow Enter key on login
document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && document.getElementById('login-page').style.display !== 'none') {
        doLogin();
    }
});

async function doLogout() {
    await fetch('/api/logout', { method: 'POST' });
    showLogin();
}

// ============================================
// ZOHO CONNECTION
// ============================================
function connectZoho() {
    window.location.href = '/oauth/start';
}

async function disconnectZoho() {
    if (!confirm('Disconnect Zoho Books? You can reconnect anytime.')) return;
    await fetch('/api/zoho/disconnect', { method: 'POST' });
    isZohoConnected = false;
    updateZohoUI(false, null);
    resetData();
    showToast('Zoho disconnected', 'info');
}

async function syncNow() {
    const btn = document.getElementById('sync-now-btn');
    btn.innerHTML = '<span class="spinner"></span> Syncing...';
    btn.disabled = true;

    try {
        const res = await fetch('/api/zoho/sync', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            updateLastSync(data.last_synced);
            await loadInvoices();
            await loadExpenses();
            await loadbills();
            showToast('✅ Sync complete!', 'success');
        } else {
            showToast('❌ ' + (data.error || 'Sync failed'), 'error');
        }
    } catch {
        showToast('❌ Sync failed', 'error');
    } finally {
        btn.innerHTML = '🔄 Sync Now';
        btn.disabled = false;
    }
}

function updateZohoUI(connected, lastSynced) {
    document.getElementById('connect-banner').style.display = connected ? 'none' : 'flex';
    document.getElementById('sync-bar').style.display = connected ? 'flex' : 'none';

    if (connected) {
        updateLastSync(lastSynced);
    }
}

function updateLastSync(ts) {
    const el = document.getElementById('last-sync-time');
    if (!ts) { el.textContent = 'Never'; return; }
    const d = new Date(ts);
    el.textContent = d.toLocaleString('en-IN');
}

function resetData() {
    document.getElementById('stat-total-count').textContent = '—';
    document.getElementById('stat-total-amt').textContent = 'Connect Zoho to see data';
    document.getElementById('stat-paid-count').textContent = '—';
    document.getElementById('stat-paid-amt').textContent = '—';
    document.getElementById('stat-pending-count').textContent = '—';
    document.getElementById('stat-pending-amt').textContent = '—';
    document.getElementById('stat-overdue-count').textContent = '—';
    document.getElementById('stat-overdue-amt').textContent = '—';
    document.getElementById('invoice-tbody').innerHTML = `<tr><td colspan="5"><div class="empty-state"><div class="emoji">🔗</div><p>Connect Zoho Books to view invoices</p></div></td></tr>`;
    document.getElementById('stat-exp-total').textContent = '—';
    document.getElementById('stat-exp-count').textContent = 'Connect Zoho to see data';
}

// ============================================
// TABS
// ============================================
function switchTab(name, btn) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
    document.getElementById('tab-' + name).classList.add('active');
    btn.classList.add('active');
}

// ============================================
// LOAD INVOICES
// ============================================
async function loadInvoices() {
    if (!isZohoConnected) return;

    const tbody = document.getElementById('invoice-tbody');
    tbody.innerHTML = `<tr><td colspan="5"><div class="loading-overlay"><div class="spinner"></div><span>Loading invoices...</span></div></td></tr>`;

    const status = document.getElementById('filter-status').value;
    const from = document.getElementById('filter-from').value;
    const to = document.getElementById('filter-to').value;

    const params = new URLSearchParams({ status });
    if (from) params.append('date_from', from);
    if (to) params.append('date_to', to);

    try {
        const res = await fetch('/api/invoices?' + params);
        console.log("res : ", res, "end");
        const data = await res.json();
        console.log("data : ", data, "end");
        if (data.error) { showToast('❌ ' + data.error, 'error'); return; }

        const { invoices, summary } = data;

        // Update stats
        document.getElementById('stat-total-count').textContent = summary.total.count;
        document.getElementById('stat-total-amt').textContent = '₹' + fmt(summary.total.amount);
        document.getElementById('stat-paid-count').textContent = summary.paid.count;
        document.getElementById('stat-paid-amt').textContent = '₹' + fmt(summary.paid.amount);
        document.getElementById('stat-pending-count').textContent = summary.pending.count;
        document.getElementById('stat-pending-amt').textContent = '₹' + fmt(summary.pending.amount);
        document.getElementById('stat-overdue-count').textContent = summary.overdue.count;
        document.getElementById('stat-overdue-amt').textContent = '₹' + fmt(summary.overdue.amount);

        // Render table
        if (!invoices.length) {
            tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><div class="emoji">📭</div><p>No invoices found for the selected filters</p></div></td></tr>`;
            return;
        }

        tbody.innerHTML = invoices.map(inv => {
            const statusClass = inv.status || 'draft';
            const statusEmoji = { paid: '✅', overdue: '⚠️', sent: '📤', draft: '📝', pending: '⏳' }[statusClass] || '•';
            return `<tr>
        <td><span class="invoice-num">${inv.invoice_number || '—'}</span></td>
        <td><span class="customer-name">${esc(inv.customer_name || '—')}</span></td>
        <td><span class="amount">₹${fmt(inv.total)}</span></td>
        <td><span class="status-badge ${statusClass}">${statusEmoji} ${statusClass}</span></td>
        <td style="color:var(--text2);font-size:12px;">${inv.due_date || '—'}</td>
      </tr>`;
        }).join('');

    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><div class="emoji">❌</div><p>Failed to load invoices. Try syncing again.</p></div></td></tr>`;
    }
}


// ============================================
// LOAD EXPENSES
// ============================================
async function loadExpenses() {
    if (!isZohoConnected) return;

    try {
        const res = await fetch('/api/expenses');
        const data = await res.json();

        if (data.error) return;

        document.getElementById('stat-exp-total').textContent = '₹' + fmt(data.total);
        document.getElementById('stat-exp-count').textContent = data.count + ' transactions';

        // This month
        const now = new Date();
        const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const monthEntry = (data.monthly || []).find(m => m.month === thisMonth);
        document.getElementById('stat-exp-month').textContent = monthEntry ? '₹' + fmt(monthEntry.amount) : '₹0';
        document.getElementById('stat-exp-month-label').textContent = now.toLocaleString('en-IN', { month: 'long', year: 'numeric' });

        // Monthly bar chart
        renderBarChart(data.monthly || []);

        // Category donut
        renderCategoryChart(data.categories || []);

    } catch (err) {
        console.error('Expense load error:', err);
    }
}

function renderBarChart(monthly) {
    const el = document.getElementById('monthly-chart');
    if (!monthly.length) {
        el.innerHTML = `<div class="empty-state"><div class="emoji">📊</div><p>No expense data yet</p></div>`;
        return;
    }
    const max = Math.max(...monthly.map(m => m.amount), 1);
    el.innerHTML = `<div class="bar-chart">${monthly.map(m => {
        const pct = Math.round((m.amount / max) * 100);
        const label = m.month.substring(0, 7);
        const [y, mo] = m.month.split('-');
        const mName = new Date(y, mo - 1, 1).toLocaleString('en-IN', { month: 'short' }) + ' ' + y.slice(2);
        return `<div class="bar-row">
      <div class="bar-label">${mName}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${pct}%">
          <span class="bar-value">₹${fmtShort(m.amount)}</span>
        </div>
      </div>
    </div>`;
    }).join('')}</div>`;
}

function renderCategoryChart(categories) {
    const el = document.getElementById('category-chart');
    if (!categories.length) {
        el.innerHTML = `<div class="empty-state"><div class="emoji">🗂️</div><p>No category data yet</p></div>`;
        return;
    }

    const colors = ['#4f7eff', '#a855f7', '#22c55e', '#f59e0b', '#ef4444', '#14b8a6', '#f97316', '#ec4899'];
    const total = categories.reduce((s, c) => s + c.amount, 0) || 1;

    // Simple SVG donut
    const size = 120, cx = 60, cy = 60, r = 45, stroke = 18;
    const circumference = 2 * Math.PI * r;
    let offset = 0;
    const segments = categories.slice(0, 8).map((c, i) => {
        const pct = c.amount / total;
        const dashArray = `${pct * circumference} ${circumference}`;
        const dashOffset = -offset * circumference;
        offset += pct;
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
      stroke="${colors[i % colors.length]}" stroke-width="${stroke}"
      stroke-dasharray="${dashArray}" stroke-dashoffset="${dashOffset}"
      transform="rotate(-90 ${cx} ${cy})" />`;
    }).join('');

    const legend = categories.slice(0, 6).map((c, i) =>
        `<div class="legend-item">
      <div class="legend-dot" style="background:${colors[i % colors.length]}"></div>
      <span class="legend-name">${esc(c.category)}</span>
      <span class="legend-val">₹${fmtShort(c.amount)}</span>
    </div>`
    ).join('');

    el.innerHTML = `<div class="donut-container">
    <svg class="donut-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--surface2)" stroke-width="${stroke}" />
      ${segments}
    </svg>
    <div class="donut-legend">${legend}</div>
  </div>`;
}

// ============================================
// HELPERS
// ============================================
function fmt(n) {
    const num = parseFloat(n) || 0;
    return num.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function fmtShort(n) {
    const num = parseFloat(n) || 0;
    if (num >= 100000) return (num / 100000).toFixed(1) + 'L';
    if (num >= 1000) return (num / 1000).toFixed(0) + 'k';
    return Math.round(num).toString();
}
function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let toastTimer;
function showToast(msg, type = 'info') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = type;
    t.style.display = 'flex';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.style.display = 'none', 4000);
}

async function refreshBillsCache() {
    const btn = event.target;
    btn.textContent = '⏳ Refreshing...';
    btn.disabled = true;

    try {
        await fetch('/api/bills/refresh', { method: 'POST' });
        console.log('✅ Cache cleared');
        await loadbills(); // Reload with fresh data
    } catch (err) {
        console.error('Failed to refresh cache:', err);
    } finally {
        btn.textContent = '🔄 Refresh';
        btn.disabled = false;
    }
}

async function loadbills() {
    const tbody = document.getElementById('bills-tbody');
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:30px;">⏳ Loading bills...</td></tr>';

    const filters = {
        status: document.getElementById('filter-status').value,
        date_from: document.getElementById('filter-from').value,
        date_to: document.getElementById('filter-to').value,
        due_date_from: document.getElementById('filter-due-from').value,
        due_date_to: document.getElementById('filter-due-to').value,
        vendor_name: document.getElementById('filter-vendor').value.trim(),
        bill_number: document.getElementById('filter-bill-number').value.trim(),
        total_min: document.getElementById('filter-total-min').value,
        total_max: document.getElementById('filter-total-max').value,
        cf_expense_related_month: document.getElementById('filter-expense-month').value,
        cf_nature_of_expense: document.getElementById('filter-nature-expense').value,
        search_text: document.getElementById('filter-search').value.trim(),
        sort_column: document.getElementById('filter-sort-column').value,
        sort_order: document.getElementById('filter-sort-order').value
    };

    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, val]) => {
        if (val && val !== 'all' && val !== '') params.append(key, val);
    });

    try {
        const res = await fetch(`/api/bills?${params.toString()}`);
        const data = await res.json();

        // ✅ Show cache status
        const cacheEl = document.getElementById('cache-status');
        if (data.from_cache) {
            cacheEl.textContent = `⚡ Cached • Expires in ${data.cache_expires_in}s`;
            cacheEl.style.color = '#4ade80';
        } else {
            cacheEl.textContent = `🔄 Fresh data`;
            cacheEl.style.color = '#60a5fa';
        }

        // ✅ Show date range info
        const countEl = document.getElementById('bills-count');
        if (data.is_default) {
            countEl.innerHTML = `📅 Last 1 month • ${data.total_count} bills`;
        } else {
            countEl.innerHTML = `📅 ${data.date_range.from} → ${data.date_range.to} • ${data.total_count} bills`;
        }

        if (!data.bills || data.bills.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state"><div class="emoji">📭</div><p>No bills found</p></div></td></tr>';
            updateBillsSummary(data.summary);
            return;
        }

        updateBillsSummary(data.summary);

        tbody.innerHTML = data.bills.map(bill => {
            const expenseMonth = bill.cf_expense_related_month
                || bill.custom_field_hash?.cf_expense_related_month || '-';
            const natureExpense = bill.cf_nature_of_expense
                || bill.custom_field_hash?.cf_nature_of_expense || '-';

            return `
        <tr class="clickable-row" onclick="openBillDetail('${bill.bill_id}')">
          <td><strong>${bill.bill_number || '-'}</strong></td>
          <td>${bill.vendor_name || '-'}</td>
          <td>₹${parseFloat(bill.total || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
          <td>₹${parseFloat(bill.balance || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
          <td><span class="status-badge-modal status-${bill.status}">${formatStatus(bill.status)}</span></td>
          <td>${bill.date || '-'}</td>
          <td>${bill.due_date || '-'}</td>
          <td>${expenseMonth}</td>
          <td>${natureExpense}</td>
        </tr>
      `;
        }).join('');

    } catch (err) {
        console.error('Error loading bills:', err);
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:red;">❌ Failed to load bills</td></tr>';
    }
}



function updateBillsSummary(summary) {
    if (!summary) return;

    document.getElementById('sum-total-count').textContent = summary.total?.count || 0;
    document.getElementById('sum-total-amount').textContent = formatCurrency(summary.total?.amount);

    document.getElementById('sum-paid-count').textContent = summary.paid?.count || 0;
    document.getElementById('sum-paid-amount').textContent = formatCurrency(summary.paid?.amount);

    document.getElementById('sum-pending-count').textContent = summary.pending?.count || 0;
    document.getElementById('sum-pending-amount').textContent = formatCurrency(summary.pending?.amount);

    document.getElementById('sum-overdue-count').textContent = summary.overdue?.count || 0;
    document.getElementById('sum-overdue-amount').textContent = formatCurrency(summary.overdue?.amount);

    document.getElementById('sum-approval-count').textContent = summary.pending_approval?.count || 0;
    document.getElementById('sum-approval-amount').textContent = formatCurrency(summary.pending_approval?.amount);
}

function clearBillFilters() {
    document.getElementById('filter-status').value = 'all';
    document.getElementById('filter-from').value = '';
    document.getElementById('filter-to').value = '';
    document.getElementById('filter-due-from').value = '';
    document.getElementById('filter-due-to').value = '';
    document.getElementById('filter-vendor').value = '';
    document.getElementById('filter-bill-number').value = '';
    document.getElementById('filter-total-min').value = '';
    document.getElementById('filter-total-max').value = '';
    document.getElementById('filter-expense-month').value = '';
    document.getElementById('filter-nature-expense').value = '';
    document.getElementById('filter-search').value = '';
    document.getElementById('filter-sort-column').value = 'date';
    document.getElementById('filter-sort-order').value = 'descending';

    loadbills();
}

function formatStatus(status) {
    return (status || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatCurrency(amount) {
    const num = parseFloat(amount) || 0;
    return '₹' + num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ✅ Open Bill Detail Modal
async function openBillDetail(billId) {
    const modal = document.getElementById('bill-detail-modal');
    const body = document.getElementById('bill-detail-body');

    modal.style.display = 'flex';
    body.innerHTML = '<p style="text-align:center;padding:40px;">⏳ Loading bill details...</p>';

    try {
        const res = await fetch(`/api/bills/${billId}`);
        const data = await res.json();

        if (!data.bill) {
            body.innerHTML = '<p style="color:red;">❌ Bill not found</p>';
            return;
        }

        const bill = data.bill;
        document.getElementById('modal-bill-title').textContent = `📄 Bill: ${bill.bill_number}`;

        body.innerHTML = `
      <!-- BASIC INFO -->
      <div class="detail-section">
        <h3>📋 Basic Information</h3>
        <div class="detail-grid">
          ${detailItem('Bill Number', bill.bill_number)}
          ${detailItem('Status', `<span class="status-badge-modal status-${bill.status}">${bill.status}</span>`)}
          ${detailItem('Vendor', bill.vendor_name)}
          ${detailItem('GST No', bill.gst_no || '-')}
          ${detailItem('GST Treatment', bill.gst_treatment || '-')}
          ${detailItem('Bill Date', bill.date)}
          ${detailItem('Due Date', bill.due_date)}
          ${detailItem('Payment Terms', bill.payment_terms_label || '-')}
          ${detailItem('Reference #', bill.reference_number || '-')}
          ${detailItem('Source of Supply', bill.source_of_supply || '-')}
          ${detailItem('Destination of Supply', bill.destination_of_supply || '-')}
          ${detailItem('Branch', bill.branch_name || '-')}
        </div>
      </div>

      <!-- AMOUNTS -->
      <div class="detail-section">
        <h3>💰 Amounts</h3>
        <div class="detail-grid">
          ${detailItem('Sub Total', formatCurrency(bill.sub_total))}
          ${detailItem('Tax Total', formatCurrency(bill.tax_total))}
          ${detailItem('Discount', formatCurrency(bill.discount_amount))}
          ${detailItem('Adjustment', formatCurrency(bill.adjustment))}
          ${detailItem('Total', `<strong style="font-size:16px;color:#059669;">${formatCurrency(bill.total)}</strong>`)}
          ${detailItem('Balance Due', `<strong style="color:#dc2626;">${formatCurrency(bill.balance)}</strong>`)}
          ${detailItem('Payment Made', formatCurrency(bill.payment_made))}
          ${detailItem('Credits Applied', formatCurrency(bill.vendor_credits_applied))}
        </div>
      </div>

      <!-- CUSTOM FIELDS -->
      ${bill.custom_fields && bill.custom_fields.length > 0 ? `
        <div class="detail-section">
          <h3>🏷️ Custom Fields</h3>
          <div class="detail-grid">
            ${bill.custom_fields.map(cf => detailItem(cf.label || cf.api_name, cf.value || '-')).join('')}
          </div>
        </div>
      ` : ''}

      <!-- CUSTOM FIELD HASH (Backup) -->
      ${bill.custom_field_hash ? `
        <div class="detail-section">
          <h3>📌 Custom Field Values</h3>
          <div class="detail-grid">
            ${Object.entries(bill.custom_field_hash)
                    .filter(([key]) => !key.includes('_unformatted'))
                    .map(([key, val]) => detailItem(formatFieldName(key), val || '-'))
                    .join('')}
          </div>
        </div>
      ` : ''}

      <!-- LINE ITEMS -->
      ${bill.line_items && bill.line_items.length > 0 ? `
        <div class="detail-section">
          <h3>📦 Line Items (${bill.line_items.length})</h3>
          <div style="overflow-x:auto;">
            <table class="line-items-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Item Name</th>
                  <th>Description</th>
                  <th>Account</th>
                  <th>HSN/SAC</th>
                  <th>Qty</th>
                  <th>Rate</th>
                  <th>Tax</th>
                  <th>Amount</th>
                  <th>Reporting Tags</th>
                </tr>
              </thead>
              <tbody>
                ${bill.line_items.map((item, i) => `
                  <tr>
                    <td>${i + 1}</td>
                    <td><strong>${item.name || item.item_name || '-'}</strong></td>
                    <td>${item.description || '-'}</td>
                    <td>${item.account_name || '-'}</td>
                    <td>${item.hsn_or_sac || '-'}</td>
                    <td>${item.quantity || 0}</td>
                    <td>${formatCurrency(item.rate)}</td>
                    <td>${item.tax_name || '-'} (${item.tax_percentage || 0}%)</td>
                    <td><strong>${formatCurrency(item.item_total)}</strong></td>
                    <td>
                      ${item.tags && item.tags.length > 0
                            ? item.tags.map(tag => `<span class="tag-badge">${tag.tag_name}: ${tag.tag_option_name}</span>`).join('')
                            : '<span style="color:#9ca3af;">No tags</span>'}
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      ` : ''}

      <!-- BILLING ADDRESS -->
      ${bill.billing_address ? `
        <div class="detail-section">
          <h3>🏢 Billing Address</h3>
          <div class="detail-grid">
            ${detailItem('Address', bill.billing_address.address || '-')}
            ${detailItem('Street 2', bill.billing_address.street2 || '-')}
            ${detailItem('City', bill.billing_address.city || '-')}
            ${detailItem('State', bill.billing_address.state || '-')}
            ${detailItem('ZIP', bill.billing_address.zip || '-')}
            ${detailItem('Country', bill.billing_address.country || '-')}
          </div>
        </div>
      ` : ''}

      <!-- SUBMISSION & APPROVAL -->
      <div class="detail-section">
        <h3>👤 Submission & Approval</h3>
        <div class="detail-grid">
          ${detailItem('Submitted By', bill.submitted_by_name || '-')}
          ${detailItem('Submitted Date', bill.submitted_date || '-')}
          ${detailItem('Submitted Email', bill.submitted_by_email || '-')}
          ${detailItem('Created', bill.created_time || '-')}
          ${detailItem('Last Modified', bill.last_modified_time || '-')}
          ${detailItem('Attachment', bill.attachment_name || 'None')}
        </div>
      </div>

      <!-- TAXES -->
      ${bill.taxes && bill.taxes.length > 0 ? `
        <div class="detail-section">
          <h3>🧾 Tax Summary</h3>
          <div class="detail-grid">
            ${bill.taxes.map(tax => detailItem(tax.tax_name, formatCurrency(tax.tax_amount))).join('')}
          </div>
        </div>
      ` : ''}
    `;
    } catch (err) {
        console.error('Error loading bill detail:', err);
        body.innerHTML = '<p style="color:red;">❌ Failed to load bill details</p>';
    }
}

// ✅ Close Modal
function closeBillModal() {
    document.getElementById('bill-detail-modal').style.display = 'none';
}

// Close on clicking outside
document.getElementById('bill-detail-modal')?.addEventListener('click', function (e) {
    if (e.target === this) closeBillModal();
});

// Close on Escape key
document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeBillModal();
});

// ✅ Helper Functions
function detailItem(label, value) {
    return `
    <div class="detail-item">
      <span class="detail-label">${label}</span>
      <span class="detail-value">${value}</span>
    </div>
  `;
}

function formatCurrency(amount) {
    const num = parseFloat(amount) || 0;
    return '₹' + num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatFieldName(key) {
    return key
        .replace(/^cf_/, '')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
}



