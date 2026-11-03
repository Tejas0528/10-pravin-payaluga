import { supabase } from './supabase.js';

const MEALS = ['Morning', 'Afternoon', 'Night'];
const TABS = [
  ['dash', 'Dashboard'],
  ['entry', 'Food Entry'],
  ['daily', 'Daily'],
  ['month', 'Monthly & Payments'],
  ['menu', 'Menu'],
  ['mem', 'Members'],
  ['profile', 'Profile']
];

function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const state = {
  user: null,
  isOwner: false,
  accessStatus: 'signed-out',
  accessRequest: null,
  accessRequests: [],
  approvalMemberIds: {},
  tab: 'dash',
  date: today(),
  month: today().slice(0, 7),
  memberId: '',
  reportMemberId: '',
  meal: 'Morning',
  menuItemId: '',
  quantity: '',
  editItemId: '',
  authMode: 'sign-in',
  recoveryMode: new URLSearchParams(window.location.hash.slice(1)).get('type') === 'recovery',
  recoveryComplete: false,
  passwordMessage: '',
  passwordError: false,
  members: [],
  menu: [],
  entries: [],
  payments: [],
  notice: '',
  noticeType: 'info',
  accessMessage: '',
  busy: false
};
let sessionLoad = null;
let sessionLoadUserId = '';

const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[char]));
const formatMoney = paise => `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})}`;
const parseMoney = value => {
  const text = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
};
const formatRupees = paise => (Number(paise || 0) / 100).toFixed(2);
const monthLabel = month => new Date(`${month}-01T00:00:00`).toLocaleString('en-IN', {
  month: 'long',
  year: 'numeric'
});
const sum = entries => entries.reduce((total, entry) => total + entry.quantity * entry.pricePaise, 0);
const selectedMember = id => state.members.find(member => member.id === id);
const selectedMenuItem = id => state.menu.find(item => item.id === id);
const memberName = id => selectedMember(id)?.name || 'Unknown member';
const menuName = id => selectedMenuItem(id)?.name || 'Removed menu item';
const entryItemName = entry => entry.itemName || menuName(entry.menuItemId);
const monthPayments = (memberId, month) => state.payments.filter(payment =>
  payment.memberId === memberId && payment.billingMonth.startsWith(month)
);
const paidAmount = (memberId, month) => monthPayments(memberId, month)
  .reduce((total, payment) => total + payment.amountPaise, 0);
const memberEntries = (memberId, month) => state.entries.filter(entry =>
  entry.memberId === memberId && entry.date.startsWith(month)
);
const statusFor = (bill, paid) => bill === 0 && paid === 0 ? 'Pending' :
  paid >= bill ? 'Paid' : paid > 0 ? 'Partially' : 'Pending';

function showNotice(message, type = 'info') {
  state.notice = message;
  state.noticeType = type;
  render();
}

function requireResult(result, operation) {
  if (result.error) {
    const error = new Error(`${operation}: ${result.error.message}`);
    error.code = result.error.code;
    throw error;
  }
  return result.data;
}

function databaseError(error) {
  const message = error?.message || 'An unexpected error occurred.';
  if (error?.showSupabaseMessage) return message;
  if (error?.code === 'PGRST205') {
    return 'Access approval is not set up yet. The owner must run supabase/security.sql in the Supabase SQL Editor before anyone uses the app.';
  }
  if (error?.code === '42501' || /row-level security|permission denied/i.test(message)) {
    return `${message} Check the Supabase RLS policies for signed-in users.`;
  }
  if (/Failed to fetch|NetworkError/i.test(message)) {
    return 'Could not reach Supabase. Check your internet connection and project URL.';
  }
  return message;
}

async function loadData() {
  const queries = [
    supabase.from('members').select('id,name').order('name'),
    supabase.from('menu_items').select('id,name,price_paise,is_active').order('name'),
    supabase.from('food_entries').select('id,member_id,entry_date,meal').order('entry_date', { ascending: false }),
    supabase.from('food_entry_items').select('id,entry_id,item_name,menu_item_id,quantity,unit_price_paise'),
    supabase.from('payments').select('id,member_id,billing_month,amount_paid_paise,payment_date')
  ];
  if (state.isOwner) {
    queries.push(supabase.from('member_access_requests')
      .select('user_id,email,status,member_id,requested_at')
      .order('requested_at', { ascending: false }));
  }
  const results = await Promise.all(queries);
  const [membersResult, menuResult, entriesResult, itemsResult, paymentsResult] = results;
  const members = requireResult(membersResult, 'Loading members');
  const menu = requireResult(menuResult, 'Loading menu');
  const entries = requireResult(entriesResult, 'Loading food entries');
  const entryItems = requireResult(itemsResult, 'Loading food entry items');
  const payments = requireResult(paymentsResult, 'Loading payments');
  const entryById = new Map(entries.map(entry => [entry.id, entry]));

  state.members = members.map(member => ({ id: member.id, name: member.name }));
  state.menu = menu.map(item => ({
    id: item.id,
    name: item.name,
    pricePaise: Number(item.price_paise),
    active: item.is_active
  }));
  state.entries = entryItems.flatMap(item => {
    const parent = entryById.get(item.entry_id);
    if (!parent) return [];
    return [{
      id: item.id,
      entryId: parent.id,
      memberId: parent.member_id,
      date: parent.entry_date,
      meal: parent.meal,
      itemName: item.item_name,
      menuItemId: item.menu_item_id,
      quantity: Number(item.quantity),
      pricePaise: Number(item.unit_price_paise)
    }];
  });
  state.payments = payments.map(payment => ({
    id: payment.id,
    memberId: payment.member_id,
    billingMonth: String(payment.billing_month),
    amountPaise: Number(payment.amount_paid_paise),
    paymentDate: payment.payment_date
  }));
  if (state.isOwner) {
    state.accessRequests = requireResult(results[5], 'Loading member approval requests');
  }

  if (!state.isOwner) {
    state.memberId = state.accessRequest.member_id;
    state.reportMemberId = state.accessRequest.member_id;
    if (!state.members.some(member => member.id === state.accessRequest.member_id)) {
      throw new Error('Your approved member link is missing. Ask the owner to check your assignment.');
    }
    state.members = state.members.filter(member => member.id === state.accessRequest.member_id);
    state.entries = state.entries.filter(entry => entry.memberId === state.accessRequest.member_id);
    state.payments = state.payments.filter(payment => payment.memberId === state.accessRequest.member_id);
  }
  if (state.isOwner && !state.members.some(member => member.id === state.memberId)) {
    state.memberId = state.members[0]?.id || '';
  }
  if (state.isOwner && !state.members.some(member => member.id === state.reportMemberId)) {
    state.reportMemberId = state.members[0]?.id || '';
  }
  const activeItems = state.menu.filter(item => item.active);
  if (!activeItems.some(item => item.id === state.menuItemId)) {
    state.menuItemId = activeItems[0]?.id || '';
  }
}

function table(headers, rows, numericColumns = []) {
  const head = headers.map((header, index) =>
    `<th class="${numericColumns.includes(index) ? 'n' : ''}">${escapeHtml(header)}</th>`
  ).join('');
  const body = rows.length ? rows.join('') :
    `<tr><td class="empty" colspan="${headers.length}">No records yet.</td></tr>`;
  return `<div class="tw"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function entryGroups(entries) {
  const groups = new Map();
  entries.forEach((entry, index) => {
    const key = `${entry.date}|${entry.memberId}`;
    if (!groups.has(key)) {
      groups.set(key, { date: entry.date, memberId: entry.memberId, entries: [], order: index });
    }
    groups.get(key).entries.push(entry);
  });
  return [...groups.values()].sort((a, b) =>
    b.date.localeCompare(a.date) || b.order - a.order
  );
}

function renderDashboard() {
  const month = today().slice(0, 7);
  const monthEntries = state.entries.filter(entry => entry.date.startsWith(month));
  const recent = entryGroups(state.entries).slice(0, 8);
  if (!state.isOwner) {
    const ownMonth = sum(monthEntries);
    const ownRecent = recent.map(group => {
      const meals = [...new Set(group.entries.map(entry => entry.meal))]
        .sort((a, b) => MEALS.indexOf(a) - MEALS.indexOf(b));
      const foods = new Map();
      group.entries.forEach(entry => {
        const name = entryItemName(entry);
        foods.set(name, (foods.get(name) || 0) + entry.quantity);
      });
      return `<tr><td>${escapeHtml(group.date)}</td><td>${meals.map(escapeHtml).join(', ')}</td><td>${[...foods].map(([name, quantity]) => `${escapeHtml(name)} × ${quantity}`).join(', ')}</td><td class="n">${formatMoney(sum(group.entries))}</td></tr>`;
    });
    return `<div class="grid">
      <div class="card"><div class="k">Your total expenses</div><div class="v">${formatMoney(sum(state.entries))}</div></div>
      <div class="card"><div class="k">${escapeHtml(monthLabel(month))} total</div><div class="v">${formatMoney(ownMonth)}</div></div>
    </div>
    <div class="card"><h2>Your recent orders</h2>${table(['Date', 'Meals', 'Food items', 'Day total'], ownRecent, [3])}</div>`;
  }
  const memberRows = state.members.map(member =>
    `<tr><td>${escapeHtml(member.name)}</td><td class="n">${formatMoney(sum(memberEntries(member.id, month)))}</td></tr>`
  );
  memberRows.push(`<tr class="t"><td>Total food expenses</td><td class="n">${formatMoney(sum(monthEntries))}</td></tr>`);
  const recentRows = recent.map(group => {
    const meals = [...new Set(group.entries.map(entry => entry.meal))]
      .sort((a, b) => MEALS.indexOf(a) - MEALS.indexOf(b));
    const foods = new Map();
    group.entries.forEach(entry => {
      const name = entryItemName(entry);
      foods.set(name, (foods.get(name) || 0) + entry.quantity);
    });
    return `<tr><td>${escapeHtml(group.date)}</td><td>${escapeHtml(memberName(group.memberId))}</td><td>${meals.map(escapeHtml).join(', ')}</td><td>${[...foods].map(([name, quantity]) => `${escapeHtml(name)} × ${quantity}`).join(', ')}</td><td class="n">${formatMoney(sum(group.entries))}</td></tr>`;
  });
  return `${state.members.some(member => /^Member \d$/.test(member.name))
    ? '<div class="card"><b>Set your members’ real names.</b> Use the Members tab to rename them.</div>' : ''}
    <div class="grid">
      <div class="card"><div class="k">Total room expenses</div><div class="v">${formatMoney(sum(state.entries))}</div></div>
      <div class="card"><div class="k">Today’s food</div><div class="v">${formatMoney(sum(state.entries.filter(entry => entry.date === today())))}</div></div>
      <div class="card"><div class="k">${escapeHtml(monthLabel(month))} food expenses</div><div class="v">${formatMoney(sum(monthEntries))}</div></div>
    </div>
    <div class="card"><h2>Member food totals – ${escapeHtml(monthLabel(month))}</h2>${table(['Member', 'Individual total'], memberRows, [1])}</div>
    <div class="card"><h2>Recent daily expenses</h2>${table(['Date', 'Member', 'Meals', 'Food items', 'Day total'], recentRows, [4])}</div>`;
}

function renderEntry() {
  const itemBeingEdited = state.entries.find(entry => entry.id === state.editItemId);
  const activeMenu = state.menu.filter(item => item.active || item.id === itemBeingEdited?.menuItemId);
  if (!activeMenu.some(item => item.id === state.menuItemId)) {
    state.menuItemId = itemBeingEdited?.menuItemId || activeMenu[0]?.id || '';
  }
  const menuItem = selectedMenuItem(state.menuItemId);
  const unitPrice = itemBeingEdited?.menuItemId === state.menuItemId
    ? itemBeingEdited.pricePaise : menuItem?.pricePaise;
  const quantity = Number.parseInt(state.quantity, 10) || 0;
  const currentEntries = state.entries.filter(entry =>
    entry.date === state.date && entry.memberId === state.memberId && entry.meal === state.meal
  );
  const memberOptions = state.members.map(member =>
    `<option value="${escapeHtml(member.id)}" ${member.id === state.memberId ? 'selected' : ''}>${escapeHtml(member.name)}</option>`
  ).join('');
  const itemOptions = activeMenu.map(item =>
    `<option value="${escapeHtml(item.id)}" ${item.id === state.menuItemId ? 'selected' : ''}>${escapeHtml(item.name)} – ${formatMoney(item.pricePaise)}</option>`
  ).join('');
  const currentRows = currentEntries.map(entry =>
    `<tr><td>${escapeHtml(entryItemName(entry))}</td><td>${entry.quantity}</td><td class="n">${formatMoney(entry.pricePaise)}</td><td class="n">${formatMoney(entry.pricePaise * entry.quantity)}</td><td><button class="btn s sm" data-action="edit-entry" data-id="${escapeHtml(entry.id)}">Edit</button> <button class="btn d sm" data-action="delete-entry" data-id="${escapeHtml(entry.id)}">Remove</button></td></tr>`
  );
  if (currentEntries.length) {
    currentRows.push(`<tr class="t"><td colspan="3">${escapeHtml(state.meal)} total</td><td class="n">${formatMoney(sum(currentEntries))}</td><td></td></tr>`);
  }
  return `<div class="card entry-card">
      <h2>${itemBeingEdited ? 'Editing entry' : 'Add food entry'}</h2>
      ${state.members.length && activeMenu.length ? `<div class="entry-fields">
        <label>Date<input class="entry-input" id="entry-date" type="date" value="${escapeHtml(state.date)}" required></label>
        <label>Member<select class="entry-input" id="entry-member" required>${memberOptions}</select></label>
        <div class="entry-field"><span class="entry-label">Meal</span><div class="meal-switch" role="group" aria-label="Meal">${MEALS.map(meal => `<button type="button" class="meal-option" data-meal="${meal}" aria-pressed="${state.meal === meal}">${meal}</button>`).join('')}</div></div>
        <label>Food item<select class="entry-input" id="entry-menu-item" required>${itemOptions}</select></label>
        <label>Quantity<input class="entry-input" id="entry-quantity" type="number" min="1" step="1" placeholder="e.g. 2" value="${escapeHtml(state.quantity)}" required></label>
      </div>
      <div class="entry-price-box"><div class="entry-price-line"><span>Unit price</span><strong id="unit-price">${unitPrice === undefined ? '—' : formatMoney(unitPrice)}</strong></div><div class="entry-price-line total"><span>Total</span><strong id="total-price">${unitPrice !== undefined && quantity > 0 ? formatMoney(unitPrice * quantity) : '—'}</strong></div></div>
      <button class="btn entry-submit" data-action="${itemBeingEdited ? 'save-entry' : 'add-entry'}">${itemBeingEdited ? 'Save changes' : '＋　Add entry'}</button>
      ${itemBeingEdited ? '<button class="btn s entry-cancel" data-action="cancel-edit">Cancel</button>' : ''}`
      : '<p class="mu">Add at least one member and one active menu item in their tabs before recording food.</p>'}
      <span class="notice entry-message ${state.noticeType}" role="status">${escapeHtml(state.notice)}</span>
    </div>
    <div class="card"><h2>${escapeHtml(memberName(state.memberId))} · ${escapeHtml(state.meal)} · ${escapeHtml(state.date)}</h2>${table(['Item', 'Qty', 'Unit price', 'Amount', ''], currentRows, [2, 3])}</div>`;
}

function renderDaily() {
  const entries = state.entries.filter(entry => entry.date === state.date);
  if (!state.isOwner) {
    const member = state.members[0];
    if (!member) return '<div class="card"><p class="notice error">Your member assignment could not be loaded.</p></div>';
    const ownEntries = entries.filter(entry => entry.memberId === member.id);
    const mealRows = MEALS.map(meal =>
      `<tr><td>${meal}</td><td class="n">${formatMoney(sum(ownEntries.filter(entry => entry.meal === meal)))}</td></tr>`
    );
    mealRows.push(`<tr class="t"><td>Your day total</td><td class="n">${formatMoney(sum(ownEntries))}</td></tr>`);
    return `<div class="card"><div class="row"><label style="max-width:220px">Date<input id="daily-date" type="date" value="${escapeHtml(state.date)}"></label></div></div>
      <div class="card"><h2>${escapeHtml(member.name)}’s orders · ${escapeHtml(state.date)}</h2>${table(['Meal', 'Your total'], mealRows, [1])}
      ${table(['Food item', 'Meal', 'Qty', 'Amount'], ownEntries.map(entry => `<tr><td>${escapeHtml(entryItemName(entry))}</td><td>${escapeHtml(entry.meal)}</td><td>${entry.quantity}</td><td class="n">${formatMoney(entry.pricePaise * entry.quantity)}</td></tr>`), [3])}</div>`;
  }
  const rows = state.members.map(member => {
    const personEntries = entries.filter(entry => entry.memberId === member.id);
    const mealCells = MEALS.map(meal =>
      `<td class="n">${formatMoney(sum(personEntries.filter(entry => entry.meal === meal)))}</td>`
    ).join('');
    return `<tr><td>${escapeHtml(member.name)}</td>${mealCells}<td class="n"><b>${formatMoney(sum(personEntries))}</b></td></tr>`;
  });
  const mealTotals = MEALS.map(meal =>
    `<td class="n">${formatMoney(sum(entries.filter(entry => entry.meal === meal)))}</td>`
  ).join('');
  rows.push(`<tr class="t"><td>Room total</td>${mealTotals}<td class="n">${formatMoney(sum(entries))}</td></tr>`);
  return `<div class="card"><div class="row"><label style="max-width:220px">Date<input id="daily-date" type="date" value="${escapeHtml(state.date)}"></label></div></div>
    <div class="card"><h2>Daily totals</h2>${table(['Member', ...MEALS, 'Day total'], rows, [1, 2, 3, 4])}</div>`;
}

function renderMonth() {
  const memberId = state.reportMemberId;
  const entries = memberEntries(memberId, state.month);
  const meals = MEALS.map(meal => `<div><div class="k">${meal} total</div><div class="v">${formatMoney(sum(entries.filter(entry => entry.meal === meal)))}</div></div>`).join('');
  const quantities = new Map();
  const itemNames = new Map();
  entries.forEach(entry => {
    quantities.set(entry.menuItemId, (quantities.get(entry.menuItemId) || 0) + entry.quantity);
    itemNames.set(entry.menuItemId, entryItemName(entry));
  });
  const itemIds = state.isOwner
    ? [...new Set([...state.menu.map(item => item.id), ...quantities.keys()])]
    : [...quantities.keys()];
  const paymentRows = monthPayments(memberId, state.month).map(payment =>
    `<tr><td><input aria-label="Payment date" type="date" data-payment-date="${escapeHtml(payment.id)}" value="${escapeHtml(payment.paymentDate || '')}"></td><td class="n"><input aria-label="Payment amount" type="number" min="0" step="0.01" data-payment-amount="${escapeHtml(payment.id)}" value="${formatRupees(payment.amountPaise)}"></td><td><button class="btn d sm" data-action="delete-payment" data-id="${escapeHtml(payment.id)}">Remove</button></td></tr>`
  );
  const allMembers = state.members.map(member => {
    const bill = sum(memberEntries(member.id, state.month));
    const paid = paidAmount(member.id, state.month);
    return `<tr><td>${escapeHtml(member.name)}</td><td class="n">${formatMoney(bill)}</td><td class="n">${formatMoney(paid)}</td><td class="n">${formatMoney(Math.max(bill - paid, 0))}</td><td><span class="b ${statusFor(bill, paid)}">${statusFor(bill, paid) === 'Partially' ? 'Partially Paid' : statusFor(bill, paid)}</span></td></tr>`;
  });
  return `<div class="card"><div class="tools">
      <label>Month<input id="report-month" type="month" value="${escapeHtml(state.month)}"></label>
      ${state.isOwner ? `<label>Member<select id="report-member">${state.members.map(member => `<option value="${escapeHtml(member.id)}" ${member.id === memberId ? 'selected' : ''}>${escapeHtml(member.name)}</option>`).join('')}</select></label>` : ''}
      <div class="report-actions"><button class="btn" data-action="pdf">⬇ PDF</button><button class="btn" data-action="xlsx">⬇ Excel</button></div>
    </div></div>
    <div class="card"><h2>${escapeHtml(memberName(memberId))} – ${escapeHtml(monthLabel(state.month))}</h2>
      <div class="grid">${meals}<div><div class="k">Monthly grand total</div><div class="v">${formatMoney(sum(entries))}</div></div></div>
      ${table(['Food item', 'Total quantity'], itemIds.map(id => `<tr class="${quantities.has(id) ? '' : 'mu'}"><td>${escapeHtml(itemNames.get(id) || menuName(id))}</td><td>${quantities.get(id) || 0}</td></tr>`))}
    </div>
    ${state.isOwner ? `<div class="card"><h2>Payments – ${escapeHtml(memberName(memberId))}</h2>
      <div class="row"><div><div class="k">Bill</div><b>${formatMoney(sum(entries))}</b></div><label style="max-width:190px">Amount (₹)<input id="payment-amount" type="number" min="0.01" step="0.01" placeholder="e.g. 100"></label><label style="max-width:190px">Payment date<input id="payment-date" type="date" value="${today()}"></label><button class="btn" data-action="add-payment">Add payment</button><div><div class="k">Paid</div><b>${formatMoney(paidAmount(memberId, state.month))}</b></div><div><div class="k">Pending</div><b>${formatMoney(Math.max(sum(entries) - paidAmount(memberId, state.month), 0))}</b></div></div>
      ${table(['Payment date', 'Amount paid', ''], paymentRows, [1])}
    </div>
    <div class="card"><h2>All members</h2>${table(['Member', 'Bill', 'Paid', 'Pending', 'Status'], allMembers, [1, 2, 3])}</div>` : ''}`;
}

function renderMenu() {
  const rows = state.menu.map(item =>
    `<tr class="${item.active ? '' : 'off'}"><td><input aria-label="Menu item name" data-menu-name="${escapeHtml(item.id)}" value="${escapeHtml(item.name)}"></td><td><input aria-label="Menu item price" data-menu-price="${escapeHtml(item.id)}" type="number" min="0" step="0.01" value="${formatRupees(item.pricePaise)}" style="width:120px"></td><td>${item.active ? 'Active' : 'Inactive'}</td><td><button class="btn s sm" data-action="toggle-menu" data-id="${escapeHtml(item.id)}">${item.active ? 'Deactivate' : 'Activate'}</button> <button class="btn d sm" data-action="delete-menu" data-id="${escapeHtml(item.id)}">Delete</button></td></tr>`
  );
  return `<div class="card menu-add-card"><h2>Add a new menu item &amp; rate</h2><div class="row"><label>Food name<input id="new-menu-name" maxlength="120"></label><label>Price (₹)<input id="new-menu-price" type="number" min="0" step="0.01" placeholder="e.g. 17.60"></label><button class="btn" data-action="add-menu">＋ Add to menu</button></div><p class="mu">New items appear in the Food Entry list. Past entries keep their recorded price.</p><span class="notice ${state.noticeType}" role="status">${escapeHtml(state.notice)}</span></div>
    <div class="card"><h2>Menu</h2><p class="mu">Changing a price affects future entries only. Used items are deactivated instead of being deleted.</p>${table(['Item', 'Price (₹)', 'Status', ''], rows)}</div>`;
}

function renderMembers() {
  const rows = state.members.map(member =>
    `<tr><td><input aria-label="Member name" data-member-name="${escapeHtml(member.id)}" maxlength="120" value="${escapeHtml(member.name)}"></td></tr>`
  );
  return `<div class="card"><h2>Member profiles</h2><p class="mu">Rename the six existing members here. Member slots cannot be added or deleted, so approved accounts stay linked to these members.</p><span class="notice ${state.noticeType}" role="status">${escapeHtml(state.notice)}</span>${table(['Member'], rows)}</div>`;
}

function renderProfile() {
  const profile = `<div class="card"><h2>Profile</h2><p class="mu">${escapeHtml(state.user?.email || 'Signed in')}</p>
    <h3>Change password</h3>
    <form id="change-password-form">
      <label>New password<input id="new-password" type="password" autocomplete="new-password" minlength="6" required></label>
      <label>Confirm new password<input id="confirm-password" type="password" autocomplete="new-password" minlength="6" required></label>
      <p class="mu">Use at least 6 characters. Supabase will enforce any additional password rules configured for this project.</p>
      <button class="btn" type="submit">Update password</button>
      <p id="password-status" class="notice ${state.passwordError ? 'error' : 'success'}" role="status" aria-live="polite">${escapeHtml(state.passwordMessage)}</p>
    </form>
  </div>`;
  return profile + (state.isOwner ? renderAccessRequests() : '');
}

function renderAccessRequests() {
  const reviewable = state.accessRequests.filter(request => request.status !== 'approved');
  const approvedByOthers = new Set(state.accessRequests
    .filter(request => request.status === 'approved')
    .map(request => request.member_id));
  const rows = reviewable.map(request => {
    const availableMembers = state.members.filter(member => !approvedByOthers.has(member.id));
    const selectedMemberId = state.approvalMemberIds[request.user_id] || '';
    const options = availableMembers.map(member =>
      `<option value="${escapeHtml(member.id)}" ${member.id === selectedMemberId ? 'selected' : ''}>${escapeHtml(member.name)}</option>`
    ).join('');
    return `<tr><td>${escapeHtml(request.email)} <span class="b ${request.status === 'rejected' ? 'Pending' : 'Partially'}">${escapeHtml(request.status)}</span></td><td><select aria-label="Assign member for ${escapeHtml(request.email)}" data-approval-member="${escapeHtml(request.user_id)}"><option value="" ${selectedMemberId ? '' : 'selected'}>Select a member</option>${options}</select></td><td><button class="btn sm" data-action="approve-request" data-id="${escapeHtml(request.user_id)}" data-member-id="${escapeHtml(selectedMemberId)}" ${availableMembers.length ? '' : 'disabled'}>Approve</button> <button class="btn d sm" data-action="reject-request" data-id="${escapeHtml(request.user_id)}">Reject</button></td></tr>`;
  });
  const allRows = state.accessRequests.map(request =>
    `<tr><td>${escapeHtml(request.email)}</td><td>${request.status === 'approved' ? escapeHtml(memberName(request.member_id)) : '—'}</td><td>${escapeHtml(request.status)}</td></tr>`
  );
  return `<div class="card"><div class="row"><h2>Member access requests</h2><button class="btn s sm" data-action="refresh-requests">Refresh requests</button></div>
      <p class="mu">Approve only people you recognize. Each existing member can be linked to one login.</p>
      ${table(['Account / request', 'Assign to existing member', ''], rows)}
      <h2>Accounts and assignments</h2>${table(['Account', 'Member', 'Access'], allRows)}
      <span class="notice ${state.noticeType}" role="status">${escapeHtml(state.notice)}</span>
    </div>`;
}

function render() {
  const nav = $('#nav');
  const app = $('#app');
  if (!nav || !app || !state.user) return;
  if (!state.isOwner && state.accessStatus !== 'approved') {
    renderAccessGate(state.accessMessage, state.accessStatus);
    return;
  }
  const tabs = state.isOwner ? TABS : [
    ['dash', 'My Expenses'],
    ['daily', 'My Orders'],
    ['month', 'Monthly Summary'],
    ['profile', 'Profile']
  ];
  if (!tabs.some(([key]) => key === state.tab)) state.tab = 'dash';
  nav.innerHTML = tabs.map(([key, label]) =>
    `<button class="${state.tab === key ? 'on' : ''}" data-tab="${key}" aria-current="${state.tab === key ? 'page' : 'false'}">${label}</button>`
  ).join('');
  const views = {
    dash: renderDashboard,
    entry: renderEntry,
    daily: renderDaily,
    month: renderMonth,
    menu: renderMenu,
    mem: renderMembers,
    profile: renderProfile
  };
  app.innerHTML = views[state.tab]();
  app.classList.toggle('busy', state.busy);
  const signedIn = $('#signed-in-user');
  if (signedIn) signedIn.textContent = state.user.email || 'Signed in';
}

function renderAccessGate(message, status) {
  const title = status === 'pending' ? 'Waiting for owner approval' :
    status === 'rejected' ? 'Access request declined' : 'Access not available';
  const detail = status === 'pending'
    ? 'Your account is registered, but your expenses are hidden until the owner approves you and assigns one of the existing members.'
    : status === 'rejected'
      ? 'The owner did not approve this account. Contact the owner if you believe this is a mistake.'
      : message || 'The owner needs to configure database access before the app can be used.';
  state.accessMessage = message;
  const tabs = [['access', 'Access status'], ['profile', 'Profile']];
  if (!tabs.some(([key]) => key === state.tab)) state.tab = 'access';
  $('#nav').innerHTML = tabs.map(([key, label]) =>
    `<button class="${state.tab === key ? 'on' : ''}" data-tab="${key}" aria-current="${state.tab === key ? 'page' : 'false'}">${label}</button>`
  ).join('');
  const canRetry = status === 'error' || status === 'pending' || status === 'rejected';
  const accessCard = `<section class="card access-gate"><h2>${title}</h2><p>${escapeHtml(detail)}</p>${canRetry ? `<button class="btn" data-action="retry-access">${status === 'error' ? 'Retry' : 'Check approval status'}</button>` : ''}<span class="notice ${status === 'error' ? 'error' : 'info'}" role="status">${status === 'error' ? escapeHtml(message) : ''}</span></section>`;
  $('#app').innerHTML = state.tab === 'profile' ? renderProfile() : accessCard;
}

function setAuthStatus(message, isError = false) {
  const status = $('#auth-status');
  if (status) {
    status.textContent = message;
    status.style.color = isError ? 'var(--er)' : 'var(--ok)';
  }
}

function renderAuthMode() {
  const signUp = state.authMode === 'sign-up';
  $('#auth-title').textContent = signUp ? 'Create your account' : '🍽 10 Pravin Payaluga';
  $('#auth-description').textContent = signUp
    ? 'Create an account. Your expenses stay hidden until the owner approves and assigns you to a member.'
    : 'Sign in to manage shared food expenses.';
  $('#auth-submit').textContent = signUp ? 'Create account' : 'Sign in';
  $('#auth-mode').textContent = signUp ? 'Back to sign in' : 'Create an account';
  $('#auth-password').autocomplete = signUp ? 'new-password' : 'current-password';
  $('#forgot-password').hidden = signUp;
}

function setRecoveryStatus(message, isError = false) {
  const status = $('#recovery-status');
  if (status) {
    status.textContent = message;
    status.style.color = isError ? 'var(--er)' : 'var(--ok)';
  }
}

function renderPasswordRecovery(user) {
  $('#auth-screen').hidden = true;
  $('#app-shell').hidden = true;
  $('#password-recovery-screen').hidden = false;
  $('#password-recovery-form').hidden = !user || state.recoveryComplete;
  $('#recovery-continue').hidden = !state.recoveryComplete;
  $('#recovery-cancel').hidden = state.recoveryComplete;
  if (!user) {
    setRecoveryStatus('This password recovery link is invalid or expired. Request a new one from the sign-in page.', true);
  } else if (state.recoveryComplete) {
    setRecoveryStatus('Password updated successfully. Your session is still active.', false);
  } else if (state.passwordMessage) {
    setRecoveryStatus(state.passwordMessage, state.passwordError);
  } else {
    setRecoveryStatus('Enter and confirm your new password.', false);
  }
}

function clearRecoveryUrl() {
  window.history.replaceState(null, document.title, `${window.location.pathname}${window.location.search}`);
}

async function requestPasswordReset() {
  const emailInput = $('#auth-email');
  if (!emailInput.value.trim()) {
    emailInput.reportValidity();
    return;
  }
  if (!emailInput.checkValidity()) {
    emailInput.reportValidity();
    return;
  }
  const { error } = await supabase.auth.resetPasswordForEmail(emailInput.value.trim(), {
    redirectTo: window.location.href.split('#')[0]
  });
  if (error) {
    setAuthStatus(error.message, true);
    return;
  }
  setAuthStatus('If an account exists for that email, Supabase will send a password recovery link.');
}

async function saveNewPassword(event) {
  event.preventDefault();
  const form = event.target;
  const isRecovery = form.id === 'password-recovery-form';
  const newPassword = $(`#${isRecovery ? 'recovery-new-password' : 'new-password'}`).value;
  const confirmation = $(`#${isRecovery ? 'recovery-confirm-password' : 'confirm-password'}`).value;
  const setMessage = (message, isError) => {
    state.passwordMessage = message;
    state.passwordError = isError;
    if (isRecovery) renderPasswordRecovery(state.user);
    else {
      const status = $('#password-status');
      status.textContent = message;
      status.className = `notice ${isError ? 'error' : 'success'}`;
    }
  };
  if (newPassword.length < 6) {
    setMessage('Password must be at least 6 characters. Supabase may enforce additional password rules.', true);
    return;
  }
  if (newPassword !== confirmation) {
    setMessage('The passwords do not match.', true);
    return;
  }
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
    form.reset();
    setMessage('Password updated successfully', false);
    if (isRecovery) {
      state.recoveryComplete = true;
      renderPasswordRecovery(state.user);
    }
  } catch (error) {
    console.error(error);
    setMessage(databaseError(error), true);
  } finally {
    submitButton.disabled = false;
  }
}

function continueAfterRecovery() {
  state.recoveryMode = false;
  state.recoveryComplete = false;
  state.passwordMessage = '';
  state.passwordError = false;
  clearRecoveryUrl();
  showApp(state.user);
}

let authGeneration = 0;
async function showApp(user) {
  if (state.recoveryMode) {
    state.user = user;
    renderPasswordRecovery(user);
    return;
  }
  if (!user) {
    authGeneration += 1;
    sessionLoad = null;
    sessionLoadUserId = '';
    state.user = null;
    state.isOwner = false;
    state.accessStatus = 'signed-out';
    state.accessRequest = null;
    state.accessRequests = [];
    state.approvalMemberIds = {};
    state.passwordMessage = '';
    state.passwordError = false;
    $('#auth-screen').hidden = false;
    $('#password-recovery-screen').hidden = true;
    $('#app-shell').hidden = true;
    state.members = [];
    state.menu = [];
    state.entries = [];
    state.payments = [];
    state.notice = '';
    return;
  }
  if (sessionLoad && sessionLoadUserId === user.id) return sessionLoad;
  const userChanged = state.user?.id !== user.id;
  const generation = ++authGeneration;
  state.user = user;
  state.isOwner = false;
  state.accessStatus = 'checking';
  if (userChanged) {
    state.tab = 'dash';
    state.passwordMessage = '';
    state.passwordError = false;
  }
  $('#auth-screen').hidden = true;
  $('#password-recovery-screen').hidden = true;
  $('#app-shell').hidden = false;
  $('#signed-in-user').textContent = user.email || 'Signed in';
  renderAccessGate('Checking account approval…', 'checking');
  sessionLoadUserId = user.id;
  sessionLoad = (async () => {
    try {
      state.isOwner = requireResult(
        await supabase.rpc('is_room_admin'),
        'Checking owner privileges'
      ) === true;
      if (!state.isOwner) {
        const requestResult = await supabase.from('member_access_requests')
          .select('user_id,email,status,member_id,requested_at')
          .eq('user_id', user.id)
          .maybeSingle();
        let request = requireResult(requestResult, 'Checking account approval');
        if (!request) {
          const insertResult = await supabase.from('member_access_requests').insert({
            user_id: user.id,
            email: user.email,
            status: 'pending',
            member_id: null
          });
          if (insertResult.error && insertResult.error.code !== '23505') {
            requireResult(insertResult, 'Submitting an access request');
          }
          const retryResult = await supabase.from('member_access_requests')
            .select('user_id,email,status,member_id,requested_at')
            .eq('user_id', user.id)
            .maybeSingle();
          request = requireResult(retryResult, 'Loading access request');
        }
        if (!request) throw new Error('Your access request could not be verified.');
        state.accessRequest = request;
        state.accessStatus = request.status;
        if (generation !== authGeneration) return;
        if (request.status !== 'approved' || !request.member_id) {
          renderAccessGate('', request.status === 'pending' || request.status === 'rejected' ? request.status : 'error');
          return;
        }
      } else {
        state.accessStatus = 'approved';
      }
      await loadData();
      if (generation !== authGeneration) return;
      state.accessStatus = 'approved';
      render();
    } catch (error) {
      if (generation !== authGeneration) return;
      state.accessStatus = 'error';
      renderAccessGate(databaseError(error), 'error');
      console.error(error);
    }
  })();
  try {
    await sessionLoad;
  } finally {
    if (generation === authGeneration) {
      sessionLoad = null;
      sessionLoadUserId = '';
    }
  }
}

async function authenticate(event) {
  event.preventDefault();
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  const result = state.authMode === 'sign-up'
    ? await supabase.auth.signUp({ email, password })
    : await supabase.auth.signInWithPassword({ email, password });
  if (result.error) {
    setAuthStatus(result.error.message, true);
    return;
  }
  if (state.authMode === 'sign-up' && !result.data.session) {
    setAuthStatus(
      'Supabase created the account without an active session. Disable email confirmation in the Supabase Email provider settings, then sign in.',
      true
    );
  } else {
    setAuthStatus('Signed in successfully.');
  }
}

async function createEntry() {
  const quantity = Number($('#entry-quantity')?.value);
  if (!state.memberId) throw new Error('Add or select a member first.');
  if (!state.menuItemId) throw new Error('Add or select an active menu item first.');
  if (!state.date || !Number.isInteger(quantity) || quantity < 1) {
    throw new Error('Choose a date and enter a whole quantity of 1 or more.');
  }
  const menuItem = selectedMenuItem(state.menuItemId);
  if (!menuItem || !menuItem.active) throw new Error('Select an active menu item.');
  let entryId;
  const existingResult = await supabase.from('food_entries')
    .select('id')
    .eq('member_id', state.memberId)
    .eq('entry_date', state.date)
    .eq('meal', state.meal)
    .limit(1)
    .maybeSingle();
  const existing = requireResult(existingResult, 'Checking the food entry');
  if (existing) {
    entryId = existing.id;
  } else {
    const parentResult = await supabase.from('food_entries').insert({
      member_id: state.memberId,
      entry_date: state.date,
      meal: state.meal
    }).select('id').single();
    entryId = requireResult(parentResult, 'Creating the food entry').id;
  }
  const findMatchingItem = () => supabase.from('food_entry_items').select('id')
    .eq('entry_id', entryId)
    .eq('item_name', menuItem.name)
    .eq('menu_item_id', menuItem.id)
    .eq('quantity', quantity)
    .eq('unit_price_paise', menuItem.pricePaise)
    .limit(1)
    .maybeSingle();
  const existingItemResult = await findMatchingItem();
  const existingItem = requireResult(existingItemResult, 'Checking for an existing food item');
  if (existingItem) {
    state.quantity = '';
    return 'This identical food item is already recorded; no duplicate was added.';
  }
  const itemResult = await supabase.from('food_entry_items').insert({
    entry_id: entryId,
    item_name: menuItem.name,
    menu_item_id: menuItem.id,
    quantity,
    unit_price_paise: menuItem.pricePaise
  });
  if (itemResult.error) {
    const verificationResult = await findMatchingItem();
    if (verificationResult.error) {
      throw new Error(`Adding the food item: ${itemResult.error.message}. Could not verify whether it was saved: ${verificationResult.error.message}`);
    }
    if (verificationResult.data) {
      state.quantity = '';
      return 'Food item was saved despite a network response issue; no duplicate was added.';
    }
    throw new Error(`Adding the food item: ${itemResult.error.message}`);
  }
  state.quantity = '';
}

async function saveEntry() {
  const current = state.entries.find(entry => entry.id === state.editItemId);
  if (!current) throw new Error('This food entry no longer exists. Refresh and try again.');
  const quantity = Number($('#entry-quantity')?.value);
  if (!state.memberId || !state.menuItemId || !state.date ||
      !Number.isInteger(quantity) || quantity < 1) {
    throw new Error('Choose a member, date and food item, then enter a whole quantity of 1 or more.');
  }
  const menuItem = selectedMenuItem(state.menuItemId);
  if (!menuItem || (!menuItem.active && menuItem.id !== current.menuItemId)) {
    throw new Error('Select an active menu item.');
  }
  const oldParent = current.entryId;
  const parentChanged = current.memberId !== state.memberId ||
    current.date !== state.date || current.meal !== state.meal;
  let targetParent = oldParent;
  let createdParent = false;
  if (parentChanged) {
    const targetResult = await supabase.from('food_entries').select('id')
      .eq('member_id', state.memberId)
      .eq('entry_date', state.date)
      .eq('meal', state.meal)
      .limit(1)
      .maybeSingle();
    const target = requireResult(targetResult, 'Checking the destination food entry');
    if (target) {
      targetParent = target.id;
    } else {
      const createResult = await supabase.from('food_entries').insert({
        member_id: state.memberId,
        entry_date: state.date,
        meal: state.meal
      }).select('id').single();
      targetParent = requireResult(createResult, 'Creating the destination food entry').id;
      createdParent = true;
    }
  }
  const pricePaise = menuItem.id === current.menuItemId
    ? current.pricePaise : menuItem.pricePaise;
  const updateResult = await supabase.from('food_entry_items').update({
    entry_id: targetParent,
    item_name: menuItem.id === current.menuItemId ? entryItemName(current) : menuItem.name,
    menu_item_id: menuItem.id,
    quantity,
    unit_price_paise: pricePaise
  }).eq('id', current.id);
  if (updateResult.error) {
    let cleanupError = '';
    if (createdParent) {
      const cleanup = await supabase.from('food_entries').delete().eq('id', targetParent);
      if (cleanup.error) cleanupError = ` The empty entry could not be removed: ${cleanup.error.message}`;
    }
    throw new Error(`Updating the food item: ${updateResult.error.message}.${cleanupError}`);
  }
  if (parentChanged) await removeEmptyParent(oldParent);
  state.editItemId = '';
  state.quantity = '';
}

async function removeEmptyParent(entryId) {
  const childrenResult = await supabase.from('food_entry_items').select('id').eq('entry_id', entryId).limit(1);
  const children = requireResult(childrenResult, 'Checking food entry items');
  if (!children.length) {
    const deleteResult = await supabase.from('food_entries').delete().eq('id', entryId);
    requireResult(deleteResult, 'Removing an empty food entry');
  }
}

async function deleteEntry(id) {
  const current = state.entries.find(entry => entry.id === id);
  if (!current) throw new Error('This food item no longer exists.');
  const result = await supabase.from('food_entry_items').delete().eq('id', id).select('id').maybeSingle();
  const deleted = requireResult(result, 'Removing the food item');
  if (!deleted) {
    throw new Error('Food item was not removed. Refresh the page and check that you are signed in as the owner.');
  }
  await removeEmptyParent(current.entryId);
}

async function addMenuItem(nameInput, priceInput) {
  const name = nameInput.trim();
  const price = parseMoney(priceInput);
  if (!name || name.length > 120 || price === null) {
    throw new Error('Enter a menu item name and a valid price with up to 2 decimals.');
  }
  const result = await supabase.from('menu_items').insert({
    name,
    price_paise: price,
    is_active: true
  });
  requireResult(result, 'Adding the menu item');
}

async function saveMenuField(input) {
  const id = input.dataset.menuName || input.dataset.menuPrice;
  const item = selectedMenuItem(id);
  if (!item) throw new Error('This menu item no longer exists.');
  const changes = {};
  if (input.dataset.menuName) {
    const name = input.value.trim();
    if (!name || name.length > 120) throw new Error('Menu item names must be 1–120 characters.');
    changes.name = name;
  } else {
    const price = parseMoney(input.value);
    if (price === null) throw new Error('Enter a valid price with up to 2 decimals.');
    changes.price_paise = price;
  }
  const result = await supabase.from('menu_items').update(changes).eq('id', id);
  requireResult(result, 'Saving the menu item');
}

async function toggleMenuItem(id) {
  const item = selectedMenuItem(id);
  if (!item) throw new Error('This menu item no longer exists.');
  const result = await supabase.from('menu_items').update({ is_active: !item.active }).eq('id', id);
  requireResult(result, 'Updating menu item status');
}

async function deleteMenuItem(id) {
  const item = selectedMenuItem(id);
  if (!item) throw new Error('This menu item no longer exists.');
  const used = state.entries.some(entry => entry.menuItemId === id);
  if (used) {
    const result = await supabase.from('menu_items').update({ is_active: false }).eq('id', id);
    requireResult(result, 'Deactivating the used menu item');
    return 'This item has food history, so it was deactivated instead of deleted.';
  }
  const result = await supabase.from('menu_items').delete().eq('id', id);
  requireResult(result, 'Deleting the menu item');
}

async function saveMemberName(input) {
  const name = input.value.trim();
  if (!name || name.length > 120) throw new Error('Member names must be 1–120 characters.');
  const result = await supabase.from('members').update({ name }).eq('id', input.dataset.memberName);
  requireResult(result, 'Saving the member name');
}

async function addPayment() {
  const amount = parseMoney($('#payment-amount')?.value);
  const paymentDate = $('#payment-date')?.value;
  if (!state.reportMemberId) throw new Error('Select a member first.');
  if (!paymentDate || !paymentDate.startsWith(state.month)) {
    throw new Error('Choose a payment date in the selected month.');
  }
  if (amount === null || amount < 1) throw new Error('Enter a payment greater than ₹0.00.');
  const result = await supabase.from('payments').insert({
    member_id: state.reportMemberId,
    billing_month: `${state.month}-01`,
    amount_paid_paise: amount,
    payment_date: paymentDate
  });
  requireResult(result, 'Adding the payment');
}

async function updatePayment(input) {
  const id = input.dataset.paymentAmount || input.dataset.paymentDate;
  const payment = state.payments.find(item => item.id === id);
  if (!payment) throw new Error('This payment no longer exists.');
  let changes;
  if (input.dataset.paymentAmount) {
    const amount = parseMoney(input.value);
    if (amount === null || amount < 1) throw new Error('Enter a payment greater than ₹0.00.');
    changes = { amount_paid_paise: amount };
  } else {
    if (!input.value || !input.value.startsWith(state.month)) {
      throw new Error('Choose a payment date in the selected month.');
    }
    changes = { payment_date: input.value };
  }
  const result = await supabase.from('payments').update(changes).eq('id', id);
  requireResult(result, 'Updating the payment');
}

async function deletePayment(id) {
  const result = await supabase.from('payments').delete().eq('id', id);
  requireResult(result, 'Removing the payment');
}

async function updateAccessRequest(userId, decision, memberId) {
  if (!state.isOwner) throw new Error('Only the owner can review access requests.');
  const request = state.accessRequests.find(item => item.user_id === userId);
  if (!request || request.status === 'approved') {
    throw new Error('This request has already been approved. Refresh the request list.');
  }
  if (decision === 'approved') {
    if (!memberId || !state.members.some(member => member.id === memberId)) {
      throw new Error('Choose one of the existing members before approving this account.');
    }
    if (state.accessRequests.some(item =>
      item.status === 'approved' && item.member_id === memberId
    )) {
      throw new Error('That member is already assigned to an approved account.');
    }
  }
  const result = await supabase.from('member_access_requests').update({
    status: decision,
    member_id: decision === 'approved' ? memberId : null
  }).eq('user_id', userId).eq('status', request.status).select('user_id').maybeSingle();
  if (result.error) {
    const error = new Error(result.error.message);
    error.showSupabaseMessage = true;
    throw error;
  }
  if (!result.data) {
    throw new Error('The request changed before your decision was saved. Refresh the request list.');
  }
  delete state.approvalMemberIds[userId];
}

function rowsForReport(memberId, month) {
  const entries = memberEntries(memberId, month).slice().sort((a, b) =>
    a.date.localeCompare(b.date) || MEALS.indexOf(a.meal) - MEALS.indexOf(b.meal)
  );
  const rows = [];
  let currentDate = '';
  let dateEntries = [];
  const appendDay = () => {
    if (!dateEntries.length) return;
    dateEntries.forEach(entry => rows.push([
      currentDate, entry.meal, entryItemName(entry), entry.quantity,
      Number(formatRupees(entry.pricePaise)), Number(formatRupees(entry.pricePaise * entry.quantity))
    ]));
    rows.push([`Daily total - ${currentDate}`, '', '', '', '', Number(formatRupees(sum(dateEntries)))]);
  };
  entries.forEach(entry => {
    if (currentDate && entry.date !== currentDate) appendDay();
    if (entry.date !== currentDate) {
      currentDate = entry.date;
      dateEntries = [];
    }
    dateEntries.push(entry);
  });
  appendDay();
  return rows;
}

function downloadReport(format) {
  const memberId = state.reportMemberId;
  if (!memberId) throw new Error('Add or select a member before exporting a report.');
  const name = memberName(memberId).replace(/\W+/g, '_');
  const filename = `10_Pravin_Payaluga_${name}_${state.month}`;
  const bill = sum(memberEntries(memberId, state.month));
  const paid = state.isOwner ? paidAmount(memberId, state.month) : 0;
  if (format === 'pdf') {
    if (!window.jspdf?.jsPDF) throw new Error('PDF library did not load. Check your internet connection and reload.');
    const doc = new window.jspdf.jsPDF();
    doc.setFontSize(16);
    doc.text('10 Pravin Payaluga - Food Expense Statement', 14, 16);
    doc.setFontSize(11);
    doc.text(`Member: ${memberName(memberId)}`, 14, 24);
    doc.text(`Month: ${monthLabel(state.month)}`, 14, 30);
    const body = rowsForReport(memberId, state.month).map(row => row.map((cell, index) =>
      index >= 4 && cell !== '' ? `Rs. ${Number(cell).toFixed(2)}` : String(cell)
    ));
    body.push(['MONTHLY GRAND TOTAL', '', '', '', '', `Rs. ${formatRupees(bill)}`]);
    if (state.isOwner) {
      body.push(['Amount paid', '', '', '', '', `Rs. ${formatRupees(paid)}`]);
      body.push(['Pending', '', '', '', '', `Rs. ${formatRupees(Math.max(bill - paid, 0))}`]);
    }
    doc.autoTable({
      startY: 36,
      head: [['Date', 'Meal', 'Food item', 'Qty', 'Unit price', 'Amount']],
      body,
      headStyles: { fillColor: [232, 89, 12] },
      styles: { fontSize: 9 }
    });
    doc.save(`${filename}.pdf`);
    return;
  }
  if (!window.XLSX?.utils) throw new Error('Excel library did not load. Check your internet connection and reload.');
  const rows = [
    ['10 Pravin Payaluga - Food Expense Statement'],
    ['Member', memberName(memberId)],
    ['Month', monthLabel(state.month)],
    [],
    ['Date', 'Meal', 'Food item', 'Quantity', 'Unit price (INR)', 'Amount (INR)'],
    ...rowsForReport(memberId, state.month),
    [],
    ['Monthly grand total', '', '', '', '', bill / 100]
  ];
  if (state.isOwner) {
    rows.push(
      ['Amount paid', '', '', '', '', paid / 100],
      ['Pending', '', '', '', '', Math.max(bill - paid, 0) / 100]
    );
  }
  const sheet = window.XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = [{ wch: 22 }, { wch: 12 }, { wch: 24 }, { wch: 10 }, { wch: 18 }, { wch: 16 }];
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, sheet, 'Statement');
  window.XLSX.writeFile(workbook, `${filename}.xlsx`);
}

async function perform(action, id, memberId) {
  if (state.busy) return;
  const ownerActions = new Set([
    'add-entry', 'save-entry', 'delete-entry', 'edit-entry', 'add-menu',
    'toggle-menu', 'delete-menu',
    'add-payment', 'delete-payment', 'approve-request', 'reject-request'
  ]);
  if (ownerActions.has(action) && !state.isOwner) {
    showNotice('Only the owner can edit this information.', 'error');
    return;
  }
  if (action === 'retry-access') {
    await showApp(state.user);
    return;
  }
  if (action === 'refresh-requests') {
    try {
      await loadData();
      showNotice('Access requests refreshed.', 'success');
    } catch (error) {
      showNotice(databaseError(error), 'error');
    }
    return;
  }
  const menuItemInput = action === 'add-menu'
    ? { name: $('#new-menu-name')?.value || '', price: $('#new-menu-price')?.value || '' }
    : null;
  state.busy = true;
  state.notice = '';
  render();
  try {
    let notice = '';
    if (action === 'add-entry') notice = await createEntry() || '';
    else if (action === 'save-entry') await saveEntry();
    else if (action === 'delete-entry') {
      if (!window.confirm('Remove this food item?')) return;
      await deleteEntry(id);
    } else if (action === 'edit-entry') {
      const entry = state.entries.find(item => item.id === id);
      if (!entry) throw new Error('This food item no longer exists.');
      state.editItemId = id;
      state.date = entry.date;
      state.memberId = entry.memberId;
      state.meal = entry.meal;
      state.menuItemId = entry.menuItemId;
      state.quantity = String(entry.quantity);
    } else if (action === 'cancel-edit') {
      state.editItemId = '';
      state.quantity = '';
    } else if (action === 'add-menu') await addMenuItem(menuItemInput.name, menuItemInput.price);
    else if (action === 'toggle-menu') await toggleMenuItem(id);
    else if (action === 'delete-menu') notice = await deleteMenuItem(id) || '';
    else if (action === 'add-payment') await addPayment();
    else if (action === 'delete-payment') {
      if (!window.confirm('Remove this payment?')) return;
      await deletePayment(id);
    } else if (action === 'approve-request') {
      await updateAccessRequest(id, 'approved', memberId);
    } else if (action === 'reject-request') {
      if (!window.confirm('Reject this signup request?')) return;
      await updateAccessRequest(id, 'rejected');
    } else if (action === 'pdf') {
      downloadReport('pdf');
      return;
    } else if (action === 'xlsx') {
      downloadReport('xlsx');
      return;
    }
    await loadData();
    state.notice = notice || ({
      'add-entry': 'Food entry added successfully.',
      'save-entry': 'Food entry updated.',
      'delete-entry': 'Food item removed.',
      'add-menu': 'Menu item added.',
      'toggle-menu': 'Menu item status updated.',
      'add-payment': 'Payment added.',
      'delete-payment': 'Payment removed.',
      'approve-request': 'Account approved and assigned to a member.',
      'reject-request': 'Access request rejected.'
    }[action] || '');
    state.noticeType = 'success';
  } catch (error) {
    state.notice = databaseError(error);
    state.noticeType = 'error';
    console.error(error);
  } finally {
    state.busy = false;
    render();
  }
}

function updateQuantityPreview() {
  const unit = $('#unit-price');
  const total = $('#total-price');
  if (!unit || !total) return;
  const editing = state.entries.find(entry => entry.id === state.editItemId);
  const item = selectedMenuItem(state.menuItemId);
  const price = editing?.menuItemId === state.menuItemId ? editing.pricePaise : item?.pricePaise;
  const quantity = Number.parseInt(state.quantity, 10);
  unit.textContent = price === undefined ? '—' : formatMoney(price);
  total.textContent = price !== undefined && quantity > 0 ? formatMoney(price * quantity) : '—';
}

async function handleChange(event) {
  const element = event.target;
  try {
    if (element.id === 'entry-date') {
      state.date = element.value;
    } else if (element.id === 'entry-member') {
      state.memberId = element.value;
      render();
    } else if (element.id === 'entry-menu-item') {
      state.menuItemId = element.value;
      updateQuantityPreview();
    } else if (element.id === 'daily-date') {
      state.date = element.value || today();
    } else if (element.id === 'report-month') {
      if (element.value) state.month = element.value;
      render();
    } else if (element.id === 'report-member') {
      state.reportMemberId = element.value;
      render();
    } else if (element.dataset.approvalMember) {
      state.approvalMemberIds[element.dataset.approvalMember] = element.value;
      render();
    } else if (element.dataset.menuName || element.dataset.menuPrice) {
      await saveMenuField(element);
      await loadData();
      showNotice('Menu item saved.', 'success');
    } else if (element.dataset.memberName) {
      await saveMemberName(element);
      await loadData();
      showNotice('Member name saved.', 'success');
    } else if (element.dataset.paymentAmount || element.dataset.paymentDate) {
      await updatePayment(element);
      await loadData();
      showNotice('Payment updated.', 'success');
    }
  } catch (error) {
    console.error(error);
    showNotice(databaseError(error), 'error');
  }
}

async function initialize() {
  renderAuthMode();
  $('#auth-form').addEventListener('submit', event => {
    authenticate(event).catch(error => {
      console.error(error);
      setAuthStatus(databaseError(error), true);
    });
  });
  $('#auth-mode').addEventListener('click', () => {
    state.authMode = state.authMode === 'sign-in' ? 'sign-up' : 'sign-in';
    setAuthStatus('');
    renderAuthMode();
  });
  $('#forgot-password').addEventListener('click', () => {
    requestPasswordReset().catch(error => {
      console.error(error);
      setAuthStatus(databaseError(error), true);
    });
  });
  $('#password-recovery-form').addEventListener('submit', event => {
    saveNewPassword(event);
  });
  $('#recovery-continue').addEventListener('click', continueAfterRecovery);
  $('#recovery-cancel').addEventListener('click', continueAfterRecovery);
  $('#google-signin').addEventListener('click', async () => {
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.href.split('#')[0] }
      });
      if (error) setAuthStatus(error.message, true);
    } catch (error) {
      console.error(error);
      setAuthStatus(databaseError(error), true);
    }
  });
  $('#signout').addEventListener('click', async () => {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) showNotice(error.message, 'error');
    } catch (error) {
      console.error(error);
      showNotice(databaseError(error), 'error');
    }
  });
  $('#nav').addEventListener('click', event => {
    const button = event.target.closest('[data-tab]');
    if (!button) return;
    state.tab = button.dataset.tab;
    state.notice = '';
    render();
  });
  $('#app').addEventListener('click', event => {
    const mealButton = event.target.closest('[data-meal]');
    if (mealButton) {
      state.meal = mealButton.dataset.meal;
      render();
      return;
    }
    const actionButton = event.target.closest('[data-action]');
    if (actionButton) {
      perform(actionButton.dataset.action, actionButton.dataset.id, actionButton.dataset.memberId);
      return;
    }
    if (event.target.id === 'reload-data') {
      showApp(state.user);
    }
  });
  $('#app').addEventListener('submit', event => {
    if (event.target.id === 'change-password-form') {
      saveNewPassword(event);
    }
  });
  $('#app').addEventListener('input', event => {
    if (event.target.id === 'entry-quantity') {
      state.quantity = event.target.value;
      updateQuantityPreview();
    }
  });
  $('#app').addEventListener('change', event => {
    handleChange(event).catch(error => {
      console.error(error);
      showNotice(databaseError(error), 'error');
    });
  });
  $('#app').addEventListener('focusout', event => {
    const element = event.target;
    if (element.id !== 'entry-date' && element.id !== 'daily-date') return;
    state.date = element.value || (element.id === 'daily-date' ? today() : '');
    window.setTimeout(() => {
      if (!state.busy) render();
    }, 0);
  });
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      state.recoveryMode = true;
      state.recoveryComplete = false;
      state.passwordMessage = '';
      state.passwordError = false;
    }
    window.setTimeout(() => {
      if (state.recoveryMode) renderPasswordRecovery(session?.user || state.user);
      else showApp(session?.user || null);
    }, 0);
  });
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (state.recoveryMode) {
    renderPasswordRecovery(data.session?.user || null);
    return;
  }
  await showApp(data.session?.user || null);
}

initialize().catch(error => {
  console.error(error);
  setAuthStatus(databaseError(error), true);
});
