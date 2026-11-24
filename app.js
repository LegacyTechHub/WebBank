const STORAGE = {
  session: "webbank-active-email"
};
const PENDING_REGISTRATION = "webbank-pending-registration";
const PENDING_PROFILE = "webbank-pending-profile";
const INTERNAL_ROUTES = ["dashboard", "transfer", "history", "account", "statements", "support", "profile"];
const SUPABASE_URL = "https://zfrwnnndfmiipcosapoi.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_RfJU1qWDol_XsZMMk1tJuQ_VvyYna30";
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { storage: window.sessionStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
});
window.__wbSupabase = supabaseClient;
[
  "webbank-session", "webbank-account", "webbank-users", "webbank-support-requests",
  "webbank-demo-session", "webbank-demo-account", "webbank-demo-users", "webbank-demo-support-requests"
].forEach((key) => localStorage.removeItem(key));

const app = document.querySelector("#app");
const menuToggle = document.querySelector(".menu-toggle");
const mainNav = document.querySelector(".main-nav");
let activeUserCache = null;
let pendingUserCache = null;
let adminUsersCache = [];
let adminUnlocked = false;
let adminErrorMessage = "";
let renderSequence = 0;

function currentSession() {
  const email = localStorage.getItem(STORAGE.session);
  return email ? { email } : null;
}

function mapUserRow(row) {
  const profile = row.profile && typeof row.profile === "object" ? row.profile : {};
  const account = row.account && typeof row.account === "object" ? row.account : {};
  account.accountNumber = row.account_number;
  account.accountType ||= profile.accountType || "Checking";
  account.currency ||= profile.currency || "USD";
  account.balance = Number.isFinite(Number(account.balance)) ? Number(account.balance) : 0;
  account.status ||= "Active";
  account.transactions = Array.isArray(account.transactions) ? account.transactions : [];
  return {
    email: row.email,
    name: row.name || row.email.split("@")[0],
    accountNumber: String(row.account_number || ""),
    passwordHash: row.password_hash || "",
    profile,
    account,
    security: row.security && typeof row.security === "object" ? row.security : { twoFactor: false, loginAlerts: true },
    createdAt: row.created_at
  };
}

function userRow(user) {
  return {
    email: user.email,
    name: user.name,
    account_number: user.accountNumber,
    password_hash: user.passwordHash || "",
    profile: user.profile || {},
    account: user.account || {},
    security: user.security || { twoFactor: false, loginAlerts: true },
    created_at: user.createdAt || new Date().toISOString()
  };
}

async function saveUser(user) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  const authUserId = user.profile.auth_user_id || session?.user?.id;
  if (!authUserId) throw new Error("An authenticated Supabase session is required to save this profile.");
  user.profile.auth_user_id = authUserId;
  const { error } = await supabaseClient.from("users").upsert(userRow(user), { onConflict: "email" });
  if (error) throw error;
  if (activeUserCache?.email === user.email) activeUserCache = user;
  if (pendingUserCache?.email === user.email) pendingUserCache = user;
}

async function findUser(email) {
  const { data, error } = await supabaseClient.from("users")
    .select("email,name,account_number,password_hash,profile,account,security,created_at")
    .eq("email", email)
    .maybeSingle();
  if (error) throw error;
  return data ? mapUserRow(data) : null;
}

async function hasAdminRole() {
  const { data, error } = await supabaseClient.auth.getUser();
  if (error) throw error;
  return data.user?.app_metadata?.role === "admin";
}

async function fetchAdminUsers() {
  if (!await hasAdminRole()) throw new Error("An administrator account is required.");
  const { data, error } = await supabaseClient.from("users")
    .select("email,name,account_number,profile,account,security,created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(mapUserRow);
}

async function manageAdminAccount(email, operation, amount, description = "") {
  if (!await hasAdminRole()) throw new Error("An administrator account is required.");
  const { data: row, error: loadError } = await supabaseClient.from("users")
    .select("email,name,account_number,profile,account,security,created_at")
    .eq("email", email)
    .single();
  if (loadError) throw loadError;
  const user = mapUserRow(row);
  let txReference;
  if (operation === "credit" || operation === "debit") {
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter an amount greater than zero.");
    if (operation === "debit" && amount > user.account.balance) throw new Error("The balance is insufficient for this debit.");
    const delta = operation === "credit" ? amount : -amount;
    user.account.balance = Math.round((user.account.balance + delta) * 100) / 100;
    txReference = "REF-" + Math.floor(10000000 + Math.random() * 90000000);
    user.account.transactions.unshift({
      id: txReference,
      reference: txReference,
      name: operation === "credit" ? String(description).trim() || "Credit from Chevron Company" : "Administrator debit",
      type: operation === "credit" ? "Credit" : "Debit",
      date: new Date().toISOString().slice(0, 10),
      amount: delta
    });
  } else if (operation === "toggle-status") {
    user.account.status = user.account.status === "Active" ? "Closed" : "Active";
  } else {
    throw new Error("Unsupported account action.");
  }
  const { error: updateError } = await supabaseClient.from("users")
    .update({ account: user.account })
    .eq("email", email);
  if (updateError) throw updateError;
  if (operation === "credit") {
    try {
      const updatedBalance = user.account.balance;
      await emailjs.send("service_qu72bmo", "template_xjtu8ni", {
        to_email: user.email,
        to_name: user.name || user.fullName || user.email,
        amount: 'USD ' + Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        account_number: '****' + String(user.account?.accountNumber || user.accountNumber || '0000').slice(-4),
        description: description || 'Credit from Chevron Company',
        reference: txReference,
        date: new Date().toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
        new_balance: 'USD ' + Number(updatedBalance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      });
      alert(`Balance credited and Chevron Company email alert sent to ${user.email}.`);
    } catch (err) {
      console.error("Chevron Company credit alert email failed:", err);
    }
  }
  return fetchAdminUsers();
}

async function reviewPendingTransfer(email, transactionId, decision) {
  if (!await hasAdminRole()) throw new Error("An administrator account is required.");
  if (!new Set(["approve", "decline"]).has(decision)) throw new Error("Unsupported transfer decision.");
  const { data: row, error: loadError } = await supabaseClient.from("users")
    .select("email,name,account_number,profile,account,security,created_at")
    .eq("email", email)
    .single();
  if (loadError) throw loadError;
  const user = mapUserRow(row);
  const transaction = user.account.transactions.find((item) => item.id === transactionId);
  if (!transaction || transaction.status !== "Pending") throw new Error("This transfer is no longer pending review.");
  if (decision === "approve") {
    const amount = Math.abs(Number(transaction.amount));
    if (amount <= 0 || amount > user.account.balance) throw new Error("The user does not have enough available balance to approve this transfer.");
    user.account.balance = Math.round((user.account.balance - amount) * 100) / 100;
    transaction.status = "Completed";
    transaction.processedAt = new Date().toISOString();
  } else {
    transaction.status = "Declined";
    transaction.declineNotified = false;
    transaction.processedAt = new Date().toISOString();
  }
  const { error: updateError } = await supabaseClient.from("users")
    .update({ account: user.account })
    .eq("email", email);
  if (updateError) throw updateError;
  return fetchAdminUsers();
}

async function markTransferNotified(email, transactionId) {
  const { data: row, error: loadError } = await supabaseClient.from("users")
    .select("email,name,account_number,profile,account,security,created_at")
    .eq("email", email)
    .single();
  if (loadError) throw loadError;
  const user = mapUserRow(row);
  const transaction = user.account.transactions.find((item) => item.id === transactionId);
  if (transaction) {
    transaction.declineNotified = true;
  }
  const { error: updateError } = await supabaseClient.from("users")
    .update({ account: user.account })
    .eq("email", email);
  if (updateError) throw updateError;
}

let modalContainer = null;

function closeModal() {
  if (modalContainer) {
    modalContainer.remove();
    modalContainer = null;
  }
}

function openModal(html) {
  closeModal();
  modalContainer = document.createElement("div");
  modalContainer.className = "receipt-modal-overlay";
  modalContainer.innerHTML = html;
  document.body.appendChild(modalContainer);
  return modalContainer;
}

async function checkDeclinedNotifications(user) {
  const declinedTransactions = user.account.transactions.filter(
    (transaction) => transaction.status === "Declined" && transaction.declineNotified !== true
  );
  if (!declinedTransactions.length) return null;

  const transaction = declinedTransactions[0];
  const declinedAtStr = new Date(transaction.date || transaction.createdAt || Date.now()).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });

  openModal(`
    <div class="receipt-modal-card declined">
      <div class="receipt-modal-icon declined" aria-hidden="true">⛔</div>
      <h2>Transfer Declined</h2>
      <p>Your recent transfer request was declined. No funds were deducted from your account. Please contact the customer support for TT-Wire Transfer Refrence Code. customerservicewebbank@gmail.com</p>
      <table class="receipt-table">
        <tr><th>Status</th><td><span class="status-badge status-declined">Declined</span></td></tr>
        <tr><th>Amount</th><td>${money(Math.abs(transaction.amount), transaction.transferCurrency || user.account.currency)} (${escapeHTML(transaction.transferCurrency || user.account.currency)})</td></tr>${transaction.recipientAddress ? `<tr><th>Recipient Address</th><td>${escapeHTML(transaction.recipientAddress)}</td></tr>` : ""}${transaction.recipientCountry ? `<tr><th>Country</th><td>${escapeHTML(transaction.recipientCountry)}</td></tr>` : ""}${transaction.recipientPhone ? `<tr><th>Phone Number</th><td>${escapeHTML(transaction.recipientPhone)}</td></tr>` : ""}${transaction.bankName ? `<tr><th>Bank Name</th><td>${escapeHTML(transaction.bankName)}</td></tr>` : ""}
        <tr><th>Recipient Name</th><td>${escapeHTML(transaction.recipientName || transaction.name)}</td></tr>
        <tr><th>Bank / Routing Number</th><td>${escapeHTML(transaction.routingNumber)}</td></tr>
        <tr><th>Account Number</th><td>${escapeHTML(transaction.accountNumber)}</td></tr>
        <tr><th>Reference / Transaction ID</th><td><code>${escapeHTML(transaction.reference)}</code></td></tr>
        <tr><th>Date</th><td>${escapeHTML(declinedAtStr)}</td></tr>
      </table>
      <button class="button" type="button" data-decline-notify-close="${escapeHTML(user.email)}" data-transaction-id="${escapeHTML(transaction.id)}">Acknowledge &amp; Close</button>
    </div>
  `);
  return transaction;
}

function generateTransactionId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "txn_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
}

async function generateAccountNumber() {
  const bytes = new Uint32Array(2);
  crypto.getRandomValues(bytes);
  const randomValue = (BigInt(bytes[0]) << 32n) | BigInt(bytes[1]);
  return String(1000000000n + (randomValue % 9000000000n));
}

function currentUser() {
  return activeUserCache;
}

async function loadActiveUser() {
  const email = localStorage.getItem(STORAGE.session);
  const { data: { session }, error } = await supabaseClient.auth.getSession();
  if (error) throw error;
  if (!email || !session || session.user.email?.toLowerCase() !== email.toLowerCase()) {
    localStorage.removeItem(STORAGE.session);
    activeUserCache = null;
    return null;
  }
  activeUserCache = await findUser(email);
  if (!activeUserCache) {
    localStorage.removeItem(STORAGE.session);
    await supabaseClient.auth.signOut();
    return null;
  }
  if (activeUserCache.profile.auth_user_id !== session.user.id) {
    localStorage.removeItem(STORAGE.session);
    activeUserCache = null;
    await supabaseClient.auth.signOut();
    return null;
  }
  return activeUserCache;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "'"
  })[character]);
}

function money(value, currency = "USD") {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${Number(value).toFixed(2)}`;
  }
}

function routeTo(route) {
  window.location.hash = route;
  mainNav.classList.remove("open");
  menuToggle.setAttribute("aria-expanded", "false");
}

function updateNav() {
  const session = currentSession();
  if (adminUnlocked) {
    mainNav.classList.add("portal-nav");
    mainNav.innerHTML = '<a href="#admin" aria-current="page">Admin Dashboard</a><button class="button button-small nav-logout" type="button" data-admin-signout>Sign out</button>';
    return;
  }
  if (session) {
    const links = [
      ["dashboard", "Dashboard"],
      ["transfer", "Transfer Funds"],
      ["history", "Transaction History"],
      ["account", "Account Management"],
      ["statements", "Statements"],
      ["support", "Help & Support"],
      ["profile", "Profile & Security"]
    ];
    const activeRoute = window.location.hash.slice(1).split("?")[0];
    mainNav.classList.add("portal-nav");
    mainNav.innerHTML = `${links.map(([route, label]) => `<a href="#${route}"${activeRoute === route ? ' aria-current="page"' : ""}>${label}</a>`).join("")}<button class="button button-small nav-logout" type="button" data-signout>Logout</button>`;
    return;
  }
  mainNav.classList.remove("portal-nav");
  mainNav.innerHTML = '<a href="#personal">Personal</a><a href="#business">Business</a><a href="#about">About</a><div class="nav-actions"><a class="button button-light button-small" href="#login">Log in</a><a class="button button-small" href="#register">Open an account</a><a class="public-admin-link" href="#admin">Administrator</a></div>';
}

function homeView() {
  return `
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero-copy">
        <p class="eyebrow">Welcome to Webbank</p>
        <h1 id="hero-title">The bank behind <em>what’s next.</em></h1>
        <p>Personal and business banking built around the people and ideas moving finance forward.</p>
        <div class="hero-buttons">
          <a class="button" href="#business">Partner with us <span aria-hidden="true">↗</span></a>
          <a class="button button-light" href="#register">Open an account</a>
          <a class="button button-light" href="#login">Log in</a>
        </div>
        <div class="trust-line"><span class="trust-mark" aria-hidden="true">✓</span><span>Member FDIC · Equal Housing Lender</span></div>
      </div>
      <div class="hero-visual" role="img" aria-label="A team working together around a table">
        <div class="hero-photo"></div>
        <div class="hero-note"><small>Built around you</small><strong>Good banking makes more possible.</strong><span>Personal and business, in one place.</span></div>
      </div>
    </section>
    <section class="section intro-section" id="about">
      <div><p class="eyebrow">Strategic partnerships</p><h2>Strong partnerships. Thoughtful banking.</h2></div>
      <div class="intro-copy"><p>We bring people, platforms, and practical financial tools together. Whether you’re managing your day-to-day or building a business, Webbank gives your next move a steadier foundation.</p><a class="intro-link" href="#business">Explore Webbank <span aria-hidden="true">→</span></a></div>
    </section>
    <section class="section differentiators" aria-labelledby="differentiators-title">
      <div class="section-heading"><div><p class="eyebrow">Key differentiators</p><h2>A partner built to move with you.</h2></div><p>Clear thinking, practical experience, and a collaborative approach to what comes next.</p></div>
      <div class="differentiator-grid">
        <article class="differentiator"><span>01</span><h3>Collaborative</h3><p>We listen closely and work alongside you to shape a solution that fits.</p></article>
        <article class="differentiator"><span>02</span><h3>Growth minded</h3><p>Flexible banking to support your next step, at every stage.</p></article>
        <article class="differentiator"><span>03</span><h3>Forward looking</h3><p>Useful digital experiences make everyday banking feel simpler.</p></article>
      </div>
    </section>
    <section class="section solutions" aria-labelledby="solutions-title">
      <div class="section-heading"><div><p class="eyebrow">Personal and business</p><h2>Solutions for every direction.</h2></div><p>Explore the support that fits the way you live, work, and grow.</p></div>
      <div class="solution-grid">
        <article class="solution-card" id="personal"><span class="card-index">01 / PERSONAL</span><h3>Make everyday feel easier.</h3><p>Keep your money close, your plans clear, and your everyday banking within reach.</p><a class="text-link" href="#register">Explore personal banking <span aria-hidden="true">→</span></a></article>
        <article class="solution-card business" id="business"><span class="card-index">02 / BUSINESS</span><h3>Give your business room to grow.</h3><p>Flexible banking for the people building something that matters.</p><a class="text-link" href="#register">Explore business banking <span aria-hidden="true">→</span></a></article>
      </div>
    </section>
    <section class="section promise">
      <div class="promise-visual" role="img" aria-label="A bright, collaborative modern workspace"></div>
      <div class="promise-copy"><p class="eyebrow">The Webbank difference</p><h2>Thoughtful by design. Ready for real life.</h2><p>Useful tools should feel simple. Helpful support should feel human. We bring the two together so you can spend less time managing money and more time moving forward.</p><a class="text-link" href="#register">Start with Webbank <span aria-hidden="true">→</span></a><div class="stat-row"><div><strong>24/7</strong><span>Access to your account</span></div><div><strong>One</strong><span>Clear place for your money</span></div></div></div>
    </section>
    <section class="cta-band"><div><p class="eyebrow">Take the next step</p><h2>A better banking relationship starts with a hello.</h2></div><a class="button" href="#register">Open an account <span aria-hidden="true">↗</span></a></section>
  `;
}

const FIELD_ICONS = {
  person: '<circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/>',
  gender: '<circle cx="10" cy="8" r="5"/><path d="M10 13v8m-4-4h8m1-13 3-3m-2 0h2v2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  heart: '<path d="M20.8 8.6c0 4.5-8.8 10-8.8 10s-8.8-5.5-8.8-10a4.6 4.6 0 0 1 8.8-1.8 4.6 4.6 0 0 1 8.8 1.8Z"/>',
  work: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18m-11 0v2h4v-2"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  phone: '<path d="M7 3H5a2 2 0 0 0-2 2c0 8.8 7.2 16 16 16a2 2 0 0 0 2-2v-2l-5-2-2 3a14 14 0 0 1-8-8l3-2-2-5Z"/>',
  address: '<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  city: '<path d="M3 21h18M5 21V7l7-4 7 4v14M9 10h1m4 0h1m-6 4h1m4 0h1m-6 7v-4h4v4"/>',
  zip: '<path d="M4 9h16M4 15h16M10 3 8 21m8-18-2 18"/>',
  country: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18m0-18a15 15 0 0 0 0 18"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3m-4 5v2"/>',
  account: '<path d="M3 21h18M4 10h16M5 10v8m4-8v8m6-8v8m4-8v8M3 7l9-4 9 4v3H3V7Z"/>',
  currency: '<circle cx="12" cy="12" r="9"/><path d="M16 8.5c-.7-.7-1.7-1-3-1-1.7 0-3 .8-3 2s1.3 2 3 2 3 .8 3 2-1.3 2-3 2c-1.3 0-2.3-.3-3-1m3-8v10"/>',
  photo: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/>'
};

function fieldIcon(name) {
  return `<svg class="field-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${FIELD_ICONS[name]}</svg>`;
}

function registrationField(name, label, type, icon, attributes = "") {
  const isPassword = type === "password";
  const toggle = isPassword ? `<button type="button" class="password-toggle" aria-label="Show password" aria-pressed="false"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>` : "";
  return `<label class="field"><span class="field-label">${label}</span><span class="input-shell${isPassword ? " password-toggle-wrapper" : ""}">${fieldIcon(icon)}<input name="${name}" type="${type}" ${attributes}>${toggle}</span></label>`;
}

function registrationSelect(name, label, icon, options, placeholder = "") {
  const firstOption = placeholder ? `<option value="" selected disabled>${placeholder}</option>` : "";
  const optionMarkup = options.map((option) => `<option value="${option}">${option}</option>`).join("");
  return `<label class="field"><span class="field-label">${label}</span><span class="input-shell select-shell">${fieldIcon(icon)}<select name="${name}" required>${firstOption}${optionMarkup}</select></span></label>`;
}

function countryOptions() {
  return ["Australia", "Brazil", "Canada", "China", "France", "Germany", "Ghana", "India", "Ireland", "Italy", "Japan", "Mexico", "Netherlands", "New Zealand", "Nigeria", "Pakistan", "Philippines", "Singapore", "South Africa", "Spain", "United Kingdom", "United States"];
}

function registrationView() {
  const countries = countryOptions();
  return `
    <section class="auth-shell registration-shell">
      <aside class="auth-aside"><div><p class="eyebrow">Welcome to Webbank</p><h1>Let’s get your next chapter started.</h1><p>Share a few details to set up your profile and account.</p></div><span class="auth-aside-foot">256-bit encrypted online banking session.</span></aside>
      <div class="auth-form-wrap"><form class="auth-form registration-form" id="auth-form" novalidate>
        <h2>Open your account</h2>
        <p class="form-intro">Complete each section to create your Webbank profile.</p>
        <section class="form-section" aria-labelledby="personal-heading">
          <div class="form-section-heading"><span>01</span><h3 id="personal-heading">Personal &amp; contact information</h3></div>
          <div class="field-grid">
            ${registrationField("firstName", "First name", "text", "person", 'autocomplete="given-name" placeholder="First name" required minlength="2"')}
            ${registrationField("lastName", "Last name", "text", "person", 'autocomplete="family-name" placeholder="Last name" required minlength="2"')}
            ${registrationSelect("gender", "Gender", "gender", ["Male", "Female", "Other"], "Select gender")}
            ${registrationField("dateOfBirth", "Date of birth", "date", "calendar", `max="${new Date().toISOString().slice(0, 10)}" required`)}
            ${registrationSelect("maritalStatus", "Marital status", "heart", ["Single", "Married", "Divorced", "Widowed"], "Marital status")}
            ${registrationField("occupation", "Occupation", "text", "work", 'autocomplete="organization-title" placeholder="Occupation" required')}
            ${registrationField("email", "Email", "email", "mail", 'autocomplete="email" placeholder="you@example.com" required')}
            ${registrationField("phone", "Phone", "tel", "phone", 'autocomplete="tel" inputmode="tel" placeholder="Phone number" required')}
          </div>
        </section>
        <section class="form-section" aria-labelledby="address-heading">
          <div class="form-section-heading"><span>02</span><h3 id="address-heading">Address details</h3></div>
          <div class="field-grid">
            ${registrationField("address", "Address", "text", "address", 'autocomplete="street-address" placeholder="Street address" required')}
            ${registrationField("city", "City", "text", "city", 'autocomplete="address-level2" placeholder="City" required')}
            ${registrationField("state", "State", "text", "address", 'autocomplete="address-level1" placeholder="State or region" required')}
            ${registrationField("zipcode", "Zipcode", "text", "zip", 'autocomplete="postal-code" placeholder="Zipcode" required')}
            ${registrationSelect("nationality", "Nationality", "country", countries, "Select country")}
          </div>
        </section>
        <section class="form-section" aria-labelledby="account-heading">
          <div class="form-section-heading"><span>03</span><h3 id="account-heading">Account &amp; security setup</h3></div>
          <div class="field-grid">
            ${registrationField("password", "Password", "password", "lock", 'autocomplete="new-password" placeholder="At least 8 characters" minlength="8" required')}
            ${registrationField("confirmPassword", "Confirm password", "password", "lock", 'autocomplete="new-password" placeholder="Re-enter password" minlength="8" required')}
            ${registrationSelect("accountType", "Account type", "account", ["Checking", "Savings", "Business"])}
            ${registrationSelect("currency", "Preferred currency", "currency", ["USD", "EUR", "GBP", "GHS", "CAD", "AUD", "JPY", "CHF", "INR"])}
            <label class="field"><span class="field-label">Passport photograph <span class="optional-label">Optional</span></span><span class="input-shell file-shell">${fieldIcon("photo")}<input name="passportPhoto" type="file" accept="image/*" aria-describedby="photo-hint"></span><small class="field-hint" id="photo-hint">Image file, up to 1.5 MB.</small></label>
          </div>
        </section>
        <section class="form-section" aria-labelledby="kin-heading">
          <div class="form-section-heading"><span>04</span><h3 id="kin-heading">Next of kin information</h3></div>
          <div class="field-grid">
            ${registrationField("kinFirstName", "First name", "text", "person", 'placeholder="First name" required minlength="2"')}
            ${registrationField("kinLastName", "Last name", "text", "person", 'placeholder="Last name" required minlength="2"')}
            ${registrationSelect("kinGender", "Gender", "gender", ["Male", "Female", "Other"], "Select gender")}
            ${registrationSelect("kinMaritalStatus", "Marital status", "heart", ["Single", "Married", "Divorced", "Widowed"], "Marital status")}
            ${registrationField("kinPhone", "Phone", "tel", "phone", 'inputmode="tel" placeholder="Phone number" required')}
            ${registrationField("kinEmail", "Email", "email", "mail", 'placeholder="name@example.com" required')}
            ${registrationField("kinAddress", "Address", "text", "address", 'placeholder="Street address" required')}
            ${registrationField("kinState", "State", "text", "address", 'placeholder="State or region" required')}
            ${registrationField("kinCity", "City", "text", "city", 'placeholder="City" required')}
            ${registrationSelect("kinNationality", "Nationality", "country", countries, "Select country")}
          </div>
        </section>
        <p class="form-message registration-message" id="form-message" aria-live="polite"></p>
        <button class="button registration-submit" type="submit">Submit <span aria-hidden="true">→</span></button>
        <p class="form-switch registration-switch">Have an account already? <a href="#login">Sign in</a></p>
      </form></div>
    </section>
  `;
}

async function pendingRegistrationUser() {
  const email = sessionStorage.getItem(PENDING_REGISTRATION);
  if (!email) return null;
  if (pendingUserCache?.email === email) return pendingUserCache;
  try {
    pendingUserCache = await findUser(email);
  } catch (error) {
    const pending = JSON.parse(sessionStorage.getItem(PENDING_PROFILE) || "null");
    if (pending?.email === email) pendingUserCache = pending.user;
    else throw error;
  }
  return pendingUserCache;
}

function registrationSuccessView() {
  const user = pendingUserCache;
  if (!user) return `<section class="registration-success-page"><article class="success-card"><h1>Registration Successful!</h1><p>Your registration details are no longer available.</p><a class="text-link" href="#login">Sign In</a></article></section>`;
  return `
    <section class="registration-success-page" aria-labelledby="registration-success-title">
      <article class="success-card">
        <span class="success-badge" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="m5 12 4.5 4.5L19 7"/></svg></span>
        <p class="eyebrow">Account created</p>
        <h1 id="registration-success-title">Registration Successful!</h1>
        <p class="success-greeting">Welcome to Webbank, ${escapeHTML(user.profile.firstName || user.name.split(" ")[0])}! Your account has been created.</p>
        <div class="success-summary" aria-label="Your account details">
          <div><span>Account number</span><strong>${escapeHTML(user.accountNumber)}</strong></div>
          <div><span>Account type</span><strong>${escapeHTML(user.profile.accountType || "Checking")}</strong></div>
          <div><span>Preferred currency</span><strong>${escapeHTML(user.profile.currency || "USD")}</strong></div>
        </div>
        <button class="button success-dashboard-button" type="button" data-enter-dashboard>Go to Dashboard <span aria-hidden="true">→</span></button>
        <p class="success-signin">Already have an account? <a href="#login">Sign In</a></p>
      </article>
    </section>
  `;
}

function verifyEmailView() {
  const email = sessionStorage.getItem(PENDING_REGISTRATION) || "your email address";
  return `
    <section class="registration-success-page" aria-labelledby="verify-email-title">
      <article class="success-card verification-card">
        <span class="success-badge verification-badge" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg></span>
        <p class="eyebrow">Email verification</p>
        <h1 id="verify-email-title">Verify your email address</h1>
        <p class="success-greeting">We sent a 6-digit verification code to ${escapeHTML(email)}. Enter the code below to complete your account setup.</p>
        <form id="verification-form" class="verification-form" novalidate>
          <label class="verification-code-label" for="verification-code">Verification code</label>
          <input id="verification-code" name="code" class="verification-code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required aria-describedby="verification-message">
          <p class="form-message" id="verification-message" aria-live="polite"></p>
          <button class="button success-dashboard-button" type="submit">Verify Email <span aria-hidden="true">→</span></button>
        </form>
        <p class="success-signin">Didn’t receive a code? <button class="resend-code-button" type="button" data-resend-code>Resend code</button></p>
        <p class="form-message verification-resend-message" id="resend-message" aria-live="polite"></p>
      </article>
    </section>
  `;
}

function authView(kind) {
  if (kind === "register") return registrationView();
  return `
    <section class="auth-shell">
      <aside class="auth-aside"><div><p class="eyebrow">Welcome to Webbank</p><h1>Good to have you back.</h1><p>Sign in to see your account and take care of the day-to-day.</p></div><span class="auth-aside-foot">256-bit encrypted online banking session.</span></aside>
      <div class="auth-form-wrap"><form class="auth-form" id="auth-form" novalidate>
        <h2>Log in to Webbank</h2>
        <p class="form-intro">Enter your details to continue to your dashboard.</p>
        <label class="field"><span>Email or Account Number</span><input name="email" type="text" autocomplete="email" placeholder="Email or Account Number" required></label>
        <label class="field"><span>Password</span><span class="password-toggle-wrapper"><input name="password" type="password" autocomplete="current-password" placeholder="Your password" required minlength="8"><button type="button" class="password-toggle" aria-label="Show password" aria-pressed="false"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></span></label>
        <button class="button" type="submit">Log in <span aria-hidden="true">→</span></button>
        <p class="form-message" id="form-message" aria-live="polite"></p>
        <p class="form-switch">New to Webbank? <a href="#register">Open an account</a></p>
      </form></div>
    </section>
  `;
}

function accountData() {
  return currentUser()?.account || null;
}

function dashboardView() {
  const session = currentSession();
  const user = currentUser(session);
  const data = accountData(session);
  const isActive = data.status === "Active";
  const profile = user.profile;
  const fullName = `${profile.firstName || user.name.split(" ")} ${profile.lastName || user.name.split(" ").slice(1).join(" ")}`.trim();
  const currency = data.currency || "USD";
  const monthKey = new Date().toISOString().slice(0, 7);
  const monthTransactions = data.transactions.filter((transaction) => transaction.date.startsWith(monthKey));
  const credits = monthTransactions.filter((transaction) => transaction.amount > 0).reduce((total, transaction) => total + transaction.amount, 0);
  const debits = Math.abs(monthTransactions.filter((transaction) => transaction.amount < 0).reduce((total, transaction) => total + transaction.amount, 0));
  const flowScale = Math.max(credits, debits, 1);
  const monthLabel = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(new Date());
  const transactions = data.transactions.slice(0, 5).map((transaction) => transactionRow(transaction, currency)).join("");
  return `
    <section class="dashboard">
      <div class="dash-topline"><div class="dash-title"><p class="eyebrow">Personal banking</p><h1>Welcome, ${escapeHTML(fullName)}.</h1><p>Your accounts at a glance.</p></div><div class="dashboard-date">${new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(new Date())}</div></div>
      <div class="dash-grid">
        <section class="balance-panel" aria-label="Account balance"><div class="balance-top"><span>${escapeHTML(data.accountType)} account</span><span class="status ${isActive ? "" : "closed"}">${data.status}</span></div><span class="balance-label">Available balance</span><div class="balance-value-row"><p class="balance-amount" data-balance-value>${money(data.balance, currency)}</p><button class="visibility-toggle" type="button" data-visibility="balance" aria-label="Hide balance" aria-pressed="false">👁️</button></div><span class="balance-caption">${escapeHTML(currency)} account · Updated just now</span></section>
        <section class="account-meta"><h2>Account summary</h2><div class="meta-row"><span>Account number</span><strong class="account-number-value" data-account-value>******${escapeHTML(user.accountNumber.slice(-4))}</strong><button class="visibility-toggle meta-eye" type="button" data-visibility="account" aria-label="Show account number" aria-pressed="false">👁️</button></div><div class="meta-row"><span>Account type</span><strong>${escapeHTML(data.accountType)}</strong></div><div class="meta-row"><span>Currency</span><strong>${escapeHTML(currency)}</strong></div></section>
      </div>
      <nav class="quick-actions" aria-label="Banking shortcuts"><a class="quick-action" href="#transfer"><span class="action-symbol" aria-hidden="true">↗</span><span>Transfer funds</span></a><a class="quick-action" href="#history"><span class="action-symbol" aria-hidden="true">↕</span><span>Transaction history</span></a><a class="quick-action" href="#account"><span class="action-symbol" aria-hidden="true">▤</span><span>Account details</span></a><a class="quick-action" href="#statements"><span class="action-symbol" aria-hidden="true">▧</span><span>Statements</span></a></nav>
      <div class="dashboard-lower-grid">
        <section class="portal-panel cashflow-panel"><div class="panel-heading"><div><p class="eyebrow">Account activity</p><h2>Monthly cash flow</h2></div><span>${monthLabel}</span></div><p class="flow-intro">Credits and debits recorded in your account this month.</p><div class="flow-row"><div><span>Money in</span><strong>${money(credits, currency)}</strong></div><div class="flow-track"><span style="width:${Math.round(credits / flowScale * 100)}%"></span></div></div><div class="flow-row"><div><span>Money out</span><strong>${money(debits, currency)}</strong></div><div class="flow-track debit-track"><span style="width:${Math.round(debits / flowScale * 100)}%"></span></div></div><p class="flow-footnote">Based on ${monthTransactions.length} transaction${monthTransactions.length === 1 ? "" : "s"} this month.</p></section>
        <section class="portal-panel account-health"><div class="panel-heading"><div><p class="eyebrow">Account standing</p><h2>Your account</h2></div><span class="status ${isActive ? "" : "closed"}">${data.status}</span></div><p class="health-copy">Your ${escapeHTML(data.accountType.toLowerCase())} account is ${isActive ? "ready for transfers and everyday banking" : "currently closed to new activity"}.</p><a class="text-link" href="#account">Manage account <span aria-hidden="true">→</span></a></section>
      </div>
      <section class="activity-panel"><div class="activity-head"><h2>Recent Transactions</h2><a href="#history">View history <span aria-hidden="true">→</span></a></div>${transactions ? transactionTable(transactions) : '<p class="empty-state">No recent transactions</p>'}</section>
      <section class="dashboard-help"><div><p class="eyebrow">Here when you need us</p><h2>Banking support, all in one place.</h2><p>Find help with your account or browse your available documents.</p></div><div><a href="#support">Help &amp; Support <span aria-hidden="true">→</span></a><a href="#statements">Statements &amp; Documents <span aria-hidden="true">→</span></a></div></section>
    </section>
  `;
}

function transactionRow(transaction, currency) {
  const credit = transaction.amount > 0;
  const status = transaction.status ? `<span class="transaction-status status-${transaction.status.toLowerCase()}">${escapeHTML(transaction.status)}</span>` : "";
  const description = transaction.description || (transaction.recipientName ? "Transfer to " + transaction.recipientName : "Account Transfer");
  const rawDate = transaction.date || transaction.createdAt || transaction.timestamp;
  const parsedDate = new Date(rawDate);
  const dateCell = !isNaN(parsedDate.getTime())
    ? parsedDate.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : String(rawDate || "Nov 23, 2026");
  return `<tr><td>${escapeHTML(description)} ${status}</td><td class="transaction-type">${escapeHTML(transaction.type)}</td><td>${escapeHTML(dateCell)}</td><td class="${credit ? "amount-in" : "amount-out"}">${credit ? "+" : "−"}${money(Math.abs(transaction.amount), currency)}</td></tr>`;
}

function pendingDebitTotal(account) {
  return account.transactions
    .filter((transaction) => transaction.status === "Pending" && transaction.amount < 0)
    .reduce((total, transaction) => total + Math.abs(Number(transaction.amount)), 0);
}

function pendingTransferActions(email, transactionId) {
  return `<div class="pending-transfer-actions"><button class="button button-small" type="button" data-pending-transfer-action="approve" data-user-email="${escapeHTML(email)}" data-transaction-id="${escapeHTML(transactionId)}">Approve</button><button class="button button-light button-small" type="button" data-pending-transfer-action="decline" data-user-email="${escapeHTML(email)}" data-transaction-id="${escapeHTML(transactionId)}">Decline</button></div>`;
}

function pendingTransferTable(transfers, includeSender = true) {
  if (!transfers.length) return '<p class="empty-state">No pending transfers.</p>';
  const senderHeading = includeSender ? "<th>Sender</th>" : "";
  const rows = transfers.map(({ user, transaction }) => `<tr>${includeSender ? `<td>${escapeHTML(user.name)}<small class="admin-transfer-email">${escapeHTML(user.email)}</small></td>` : ""}<td><strong>${escapeHTML(transaction.recipientName || transaction.name)}</strong>${transaction.recipientCountry ? `<small class="admin-transfer-email">${escapeHTML(transaction.recipientCountry)}${transaction.recipientAddress ? " · " + escapeHTML(transaction.recipientAddress) : ""}</small>` : ""}${transaction.recipientPhone ? `<small class="admin-transfer-email">${escapeHTML(transaction.recipientPhone)}</small>` : ""}</td><td>${transaction.bankName ? `<strong>${escapeHTML(transaction.bankName)}</strong><small class="admin-transfer-email">${escapeHTML(transaction.routingNumber || "—")}</small>` : escapeHTML(transaction.routingNumber || "—")}</td><td>${escapeHTML(transaction.accountNumber || "—")}</td><td>${money(Math.abs(transaction.amount), user.account.currency)}</td><td>${new Date(transaction.createdAt || transaction.date).toLocaleString()}</td><td>${pendingTransferActions(user.email, transaction.id)}</td></tr>`).join("");
  return `<div class="transaction-wrap"><table class="transactions pending-transfer-table"><thead><tr>${senderHeading}<th>Recipient</th><th>Bank / Routing</th><th>Account</th><th>Amount</th><th>Submitted</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function transactionTable(rows) {
  return `<div class="transaction-wrap"><table class="transactions"><thead><tr><th>Description</th><th>Type</th><th>Date</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function transferView() {
  const user = currentUser();
  const account = user.account;
  const availableBalance = Math.max(0, account.balance - pendingDebitTotal(account));
  return `
    <section class="portal-page">
      <div class="page-heading"><p class="eyebrow">Payments</p><h1>Transfer Funds</h1><p>Send a transfer from your ${escapeHTML(account.accountType.toLowerCase())} account.</p></div>
      <div class="portal-layout"><form class="portal-panel portal-form" id="transfer-form" novalidate>
        <div class="panel-heading"><h2>Recipient details</h2><span>Available balance: ${money(availableBalance, account.currency)}</span></div>
        <label class="portal-field"><span>Recipient full name</span><input name="recipientName" autocomplete="name" placeholder="Full legal name" required></label><label class="portal-field"><span>Recipient address</span><input name="recipientAddress" placeholder="Residential address and city" required></label><label class="portal-field"><span>Country</span><select name="recipientCountry" required><option value="United States" selected>United States</option><option value="Germany">Germany</option><option value="United Kingdom">United Kingdom</option><option value="Canada">Canada</option><option value="Ghana">Ghana</option><option value="Nigeria">Nigeria</option><option value="France">France</option><option value="United Arab Emirates">United Arab Emirates</option><option value="South Africa">South Africa</option><option value="Other International">Other International</option></select></label><label class="portal-field"><span>Recipient phone number</span><input name="recipientPhone" type="tel" placeholder="+1 555 019 2834" required></label><label class="portal-field"><span>Bank name</span><input name="bankName" placeholder="Receiving bank name" required></label><label class="portal-field"><span>Currency</span><select name="transferCurrency" required><option value="USD">USD ($)</option><option value="EUR">EUR (€)</option><option value="GBP">GBP (£)</option><option value="GHS">GHS (₵)</option></select></label>
        <label class="portal-field"><span>Recipient bank / routing number</span><input name="routingNumber" inputmode="numeric" autocomplete="off" placeholder="Bank or routing number" required minlength="4"></label>
        <label class="portal-field"><span>Account number</span><input name="recipientAccount" inputmode="numeric" autocomplete="off" placeholder="Recipient account number" required minlength="4"></label>
        <label class="portal-field"><span>Amount (${escapeHTML(account.currency)})</span><input name="amount" type="number" min="0.01" max="${availableBalance}" step="0.01" placeholder="0.00" required></label>
        <label class="portal-field"><span>Transfer note</span><textarea name="note" rows="3" maxlength="120" placeholder="What is this transfer for?"></textarea></label>
        <p class="form-message" id="transfer-message" aria-live="polite"></p>
        ${account.status === "Active" ? '<button class="button" type="submit">Review transfer <span aria-hidden="true">→</span></button>' : '<p class="closed-notice">Transfers are unavailable while this account is closed.</p>'}
      </form><aside class="portal-panel transfer-summary"><p class="eyebrow">From your account</p><h2>${escapeHTML(account.accountType)} · ${escapeHTML(account.currency)}</h2><p class="summary-account">Account ending ${escapeHTML(user.accountNumber.slice(-4))}</p><p class="summary-balance">${money(availableBalance, account.currency)}</p><span class="status ${account.status === "Active" ? "" : "closed"}">${account.status}</span></aside></div>
    </section>
  `;
}

function historyView() {
  const user = currentUser();
  const account = user.account;
  return `
    <section class="portal-page">
      <div class="page-heading"><p class="eyebrow">Activity</p><h1>Transaction History</h1><p>Filter and review your account activity.</p></div>
      <section class="portal-panel">
        <form class="history-filters" id="history-filters">
          <label class="portal-field"><span>Type</span><select name="type"><option value="all">All transactions</option><option value="credit">Credits (Money in)</option><option value="debit">Debits (Money out)</option></select></label>
          <label class="portal-field"><span>From</span><input name="from" type="date"></label>
          <label class="portal-field"><span>To</span><input name="to" type="date"></label>
          <div class="filter-actions"><button class="button button-small" type="submit">Filter</button><button class="button button-light button-small" type="reset">Reset</button></div>
        </form>
        <div class="activity-head"><h2>Transactions</h2><span>${account.transactions.length} total</span></div>
        <div id="history-results">${historyResults(account.transactions, account.currency)}</div>
      </section>
    </section>
  `;
}

function historyResults(transactions, currency) {
  const rows = transactions.map((transaction) => transactionRow(transaction, currency)).join("");
  return rows ? transactionTable(rows) : '<p class="empty-state">No recent transactions</p>';
}

function accountView() {
  const user = currentUser();
  const account = user.account;
  const active = account.status === "Active";
  return `
    <section class="portal-page">
      <div class="page-heading"><p class="eyebrow">Your account</p><h1>Account Management</h1><p>Manage your account status and available funds.</p></div>
      <div class="account-management-layout"><section class="portal-panel account-management-card"><div class="panel-heading"><h2>${escapeHTML(account.accountType)} account</h2><span class="status ${active ? "" : "closed"}">${account.status}</span></div><dl class="account-details"><div><dt>Account number</dt><dd>${escapeHTML(user.accountNumber)}</dd></div><div><dt>Preferred currency</dt><dd>${escapeHTML(account.currency)}</dd></div><div><dt>Available balance</dt><dd>${money(account.balance, account.currency)}</dd></div></dl><div class="panel-actions"><button class="button" type="button" data-account-action="open" ${active ? "disabled" : ""}>Open Account</button><button class="button button-light" type="button" data-account-action="close" ${active ? "" : "disabled"}>Close Account</button></div></section></div>
    </section>
  `;
}

function statementsView() {
  return `<section class="portal-page"><div class="page-heading"><p class="eyebrow">Documents</p><h1>Statements &amp; Documents</h1><p>Monthly statements will appear here when available.</p></div><section class="portal-panel empty-panel"><span class="empty-symbol" aria-hidden="true">▤</span><h2>No statements available yet</h2><p>Your account has no documents to display.</p></section></section>`;
}

function supportView() {
  return `
    <section class="portal-page"><div class="page-heading"><p class="eyebrow">We’re here to help</p><h1>Help &amp; Support</h1><p>Send a message or browse common questions.</p></div>
      <div class="portal-layout"><form class="portal-panel portal-form" id="support-form"><h2>Contact support</h2><label class="portal-field"><span>Your name</span><input name="name" autocomplete="name" required></label><label class="portal-field"><span>Email address</span><input name="email" type="email" autocomplete="email" required></label><label class="portal-field"><span>How can we help?</span><textarea name="message" rows="5" maxlength="1000" required></textarea></label><p class="form-message" id="support-message" aria-live="polite"></p><button class="button" type="submit">Send message <span aria-hidden="true">→</span></button></form>
      <section class="portal-panel faq-panel"><h2>Frequently asked questions</h2><details><summary>How do I open or close my account?</summary><p>Visit Account Management in your navigation menu to toggle your account status anytime.</p></details><details><summary>How fast are transfers processed?</summary><p>Transfers update your available balance immediately upon submission.</p></details><details><summary>Where can I update my password?</summary><p>Open Profile &amp; Security to update your password or adjust security alerts.</p></details></section></div>
    </section>
  `;
}

function profileView() {
  const user = currentUser();
  const profile = user.profile;
  const account = user.account;
  const details = [
    ["First name", profile.firstName], ["Last name", profile.lastName], ["Gender", profile.gender], ["Date of birth", profile.dateOfBirth],
    ["Marital status", profile.maritalStatus], ["Occupation", profile.occupation], ["Email", user.email], ["Phone", profile.phone],
    ["Address", profile.address], ["City", profile.city], ["State", profile.state], ["Zipcode", profile.zipcode], ["Nationality", profile.nationality],
    ["Account number", user.accountNumber], ["Account type", account.accountType], ["Currency", account.currency],
    ["Next of kin first name", profile.kinFirstName], ["Next of kin last name", profile.kinLastName], ["Next of kin gender", profile.kinGender],
    ["Next of kin marital status", profile.kinMaritalStatus], ["Next of kin phone", profile.kinPhone], ["Next of kin email", profile.kinEmail],
    ["Next of kin address", profile.kinAddress], ["Next of kin state", profile.kinState], ["Next of kin city", profile.kinCity], ["Next of kin nationality", profile.kinNationality]
  ];
  const rows = details.map(([label, value]) => `<div class="profile-item"><dt>${label}</dt><dd>${escapeHTML(value || "Not provided")}</dd></div>`).join("");
  return `
    <section class="portal-page"><div class="page-heading"><p class="eyebrow">Your information</p><h1>Profile &amp; Security</h1><p>Review your saved profile and security preferences.</p></div>
      <section class="portal-panel profile-panel"><div class="panel-heading"><h2>Personal and account information</h2>${profile.passportPhoto ? `<img class="passport-preview" src="${profile.passportPhoto}" alt="Passport photograph preview">` : ""}</div><dl class="profile-grid">${rows}</dl></section>
      <div class="portal-layout profile-settings"><form class="portal-panel portal-form" id="password-form"><h2>Change password</h2><label class="portal-field password-toggle-wrapper"><span>Current password</span><input name="currentPassword" type="password" autocomplete="current-password" minlength="8" required><button type="button" class="password-toggle" aria-label="Show password" aria-pressed="false"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></label><label class="portal-field password-toggle-wrapper"><span>New password</span><input name="newPassword" type="password" autocomplete="new-password" minlength="8" required><button type="button" class="password-toggle" aria-label="Show password" aria-pressed="false"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></label><label class="portal-field password-toggle-wrapper"><span>Confirm new password</span><input name="confirmNewPassword" type="password" autocomplete="new-password" minlength="8" required><button type="button" class="password-toggle" aria-label="Show password" aria-pressed="false"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></label><p class="form-message" id="password-message" aria-live="polite"></p><button class="button" type="submit">Update password</button></form><section class="portal-panel security-panel"><h2>Security preferences</h2><label class="security-toggle"><span><strong>Two-Factor Authentication</strong><small>Require verification when signing in on new devices.</small></span><input type="checkbox" data-security="twoFactor" ${user.security.twoFactor ? "checked" : ""}><span class="switch-ui"></span></label><label class="security-toggle"><span><strong>Login Alerts</strong><small>Receive an alert whenever a new session starts.</small></span><input type="checkbox" data-security="loginAlerts" ${user.security.loginAlerts ? "checked" : ""}><span class="switch-ui"></span></label><p class="security-message" id="security-message" aria-live="polite"></p></section></div>
    </section>
  `;
}

function adminLoginView() {
  return `
    <section class="portal-page admin-login-page"><form class="portal-panel portal-form admin-login-form" id="admin-login-form"><p class="eyebrow">Restricted access</p><h1>Administrator sign in</h1><p class="panel-copy">Sign in with an authorized administrator account.</p><label class="portal-field"><span>Email address</span><input name="email" type="email" autocomplete="username" required></label><label class="portal-field password-toggle-wrapper"><span>Password</span><input name="password" type="password" autocomplete="current-password" required><button type="button" class="password-toggle" aria-label="Show password" aria-pressed="false"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></label><p class="form-message error" id="admin-login-message" aria-live="polite">${escapeHTML(adminErrorMessage)}</p><button class="button" type="submit">Sign in securely</button></form></section>
  `;
}

function adminDetailsMarkup(user) {
  const profileLabels = [
    ["First name", "firstName"], ["Last name", "lastName"], ["Gender", "gender"], ["Date of birth", "dateOfBirth"],
    ["Marital status", "maritalStatus"], ["Occupation", "occupation"], ["Phone", "phone"], ["Address", "address"],
    ["City", "city"], ["State", "state"], ["Zipcode", "zipcode"], ["Nationality", "nationality"],
    ["Next of kin first name", "kinFirstName"], ["Next of kin last name", "kinLastName"], ["Next of kin gender", "kinGender"],
    ["Next of kin marital status", "kinMaritalStatus"], ["Next of kin phone", "kinPhone"], ["Next of kin email", "kinEmail"],
    ["Next of kin address", "kinAddress"], ["Next of kin state", "kinState"], ["Next of kin city", "kinCity"], ["Next of kin nationality", "kinNationality"]
  ];
  const fields = profileLabels.map(([label, key]) => `<div class="profile-item"><dt>${label}</dt><dd>${escapeHTML(user.profile[key] || "Not provided")}</dd></div>`).join("");
  const photo = user.profile.passportPhoto ? `<img class="passport-preview" src="${user.profile.passportPhoto}" alt="Passport photograph for ${escapeHTML(user.name)}">` : "";
  const pendingTransfers = user.account.transactions.filter((transaction) => transaction.status === "Pending");
  const pendingRows = pendingTransferTable(pendingTransfers.map((transaction) => ({ user, transaction })), false);
  return `<div class="admin-detail-head"><div><p class="eyebrow">User profile</p><h2>${escapeHTML(user.name)}</h2><p>${escapeHTML(user.email)}</p></div>${photo}</div><dl class="profile-grid">${fields}</dl><section class="admin-detail-account"><h3>Account controls</h3><p>${escapeHTML(user.account.accountType)} · ${escapeHTML(user.account.currency)} · ${money(user.account.balance, user.account.currency)} · ${escapeHTML(user.account.status)}</p><form id="admin-control-form" data-user-email="${escapeHTML(user.email)}"><label class="portal-field"><span>Amount (${escapeHTML(user.account.currency)})</span><input name="amount" type="number" min="0.01" max="100000000" step="0.01" placeholder="0.00"></label><label class="portal-field"><span>Description / Sender</span><input name="description" type="text" maxlength="120" value="Credit from Chevron Company"></label><div class="panel-actions"><button class="button button-small" type="submit" name="action" value="credit">Credit balance</button><button class="button button-light button-small" type="submit" name="action" value="debit">Debit balance</button><button class="button button-light button-small" type="submit" name="action" value="toggle-status">${user.account.status === "Active" ? "Close account" : "Open account"}</button></div></form></section><section class="admin-pending-detail"><h3>Pending transfers</h3>${pendingRows}</section>`;
}

function adminView() {
  if (!adminUnlocked) return adminLoginView();
  const users = adminUsersCache.map((row) => row.account_number ? mapUserRow(row) : row);
  const active = users.filter((user) => user.account.status === "Active").length;
  const pendingTransfers = users.flatMap((user) => user.account.transactions.filter((transaction) => transaction.status === "Pending").map((transaction) => ({ user, transaction })));
  const balancesByCurrency = users.reduce((totals, user) => {
    const currency = user.account.currency || "USD";
    totals.set(currency, (totals.get(currency) || 0) + Number(user.account.balance || 0));
    return totals;
  }, new Map());
  const totalBalances = [...balancesByCurrency].map(([currency, total]) => money(total, currency)).join(" · ") || money(0, "USD");
  return `
    <section class="portal-page admin-page"><div class="page-heading"><p class="eyebrow">Administration</p><h1>Account overview</h1><p>Review and manage registered Webbank accounts.</p></div>
      <div class="admin-stats"><article class="portal-panel"><span>Total Registered Users</span><strong>${users.length}</strong></article><article class="portal-panel"><span>Active Accounts</span><strong>${active}</strong></article><article class="portal-panel"><span>Total Balances</span><strong>${totalBalances}</strong></article></div>
      <section class="portal-panel pending-queue-panel"><div class="admin-table-heading"><div><h2>Pending Transfers</h2><p>${pendingTransfers.length} awaiting administrator review</p></div></div>${pendingTransferTable(pendingTransfers)}</section>
      <section class="portal-panel admin-users-panel"><div class="admin-table-heading"><div><h2>Registered users</h2><p>View profiles and manage account balances or status.</p></div><label class="admin-search"><span class="visually-hidden">Search users</span><input id="admin-search" type="search" placeholder="Search name, email or account"></label></div><div class="transaction-wrap"><table class="transactions admin-table"><thead><tr><th>Full Name</th><th>Email</th><th>Account Number</th><th>Type</th><th>Currency</th><th>Balance</th><th>Status</th><th>Sign-up Date</th><th></th></tr></thead><tbody id="admin-users-body">${adminUserRows(users)}</tbody></table></div></section>
      <dialog class="admin-details-dialog" id="admin-details-dialog"><div class="admin-dialog-content" id="admin-dialog-content"></div><form method="dialog" class="admin-dialog-close"><button class="button button-light button-small">Close</button></form></dialog>
    </section>
  `;
}

function adminUserRows(users) {
  if (!users.length) return '<tr><td class="empty-state" colspan="9">No registered users found.</td></tr>';
  return users.map((user) => `<tr><td>${escapeHTML(user.name)}</td><td>${escapeHTML(user.email)}</td><td>${escapeHTML(user.accountNumber)}</td><td>${escapeHTML(user.account.accountType)}</td><td>${escapeHTML(user.account.currency)}</td><td>${money(user.account.balance, user.account.currency)}</td><td><span class="status ${user.account.status === "Active" ? "" : "closed"}">${escapeHTML(user.account.status)}</span></td><td>${user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "—"}</td><td><button class="button button-light button-small" type="button" data-admin-view="${escapeHTML(user.email)}">View Details</button></td></tr>`).join("");
}

function portalView(route) {
  return ({ dashboard: dashboardView, transfer: transferView, history: historyView, account: accountView, statements: statementsView, support: supportView, profile: profileView })[route]();
}

async function render() {
  const sequence = ++renderSequence;
  const requested = window.location.hash.slice(1).split("?")[0] || "home";
  const sectionTarget = ["personal", "business", "about"].includes(requested) ? requested : null;
  let route = sectionTarget ? "home" : requested;
  if (!["home", "login", "register", "verify-email", "registration-success", "admin", ...INTERNAL_ROUTES].includes(route)) route = "home";
  if (route === "verify-email" && (!sessionStorage.getItem(PENDING_REGISTRATION) || !sessionStorage.getItem(PENDING_PROFILE))) {
    route = "register";
    window.location.hash = "register";
  }
  if (route === "registration-success") {
    try {
      await pendingRegistrationUser();
    } catch (error) {
      pendingUserCache = null;
    }
    if (sequence !== renderSequence) return;
  }
  if (route === "registration-success" && !pendingUserCache) {
    route = "register";
    window.location.hash = "register";
  }
  if (INTERNAL_ROUTES.includes(route)) {
    try {
      const user = await loadActiveUser();
      if (sequence !== renderSequence) return;
      if (!user) {
        window.location.hash = "login";
        route = "login";
      }
    } catch (error) {
      if (sequence !== renderSequence) return;
      localStorage.removeItem(STORAGE.session);
      activeUserCache = null;
      route = "login";
    }
  }
  if (route === "admin" && adminUnlocked) {
    try {
      adminUsersCache = await fetchAdminUsers();
    } catch (error) {
      adminUnlocked = false;
      adminErrorMessage = error.message;
    }
    if (sequence !== renderSequence) return;
  }
  updateNav();
  app.innerHTML = route === "home" ? homeView() : route === "login" || route === "register" ? authView(route) : route === "verify-email" ? verifyEmailView() : route === "registration-success" ? registrationSuccessView() : route === "admin" ? adminView() : portalView(route);
  app.dataset.route = route;

  if (route === "dashboard" && activeUserCache) {
    try {
      await checkDeclinedNotifications(activeUserCache);
    } catch (error) {
      // Silently ignore declined notification errors; they should not block dashboard rendering
    }
  }
  document.querySelector(".site-footer").hidden = route === "verify-email" || route === "registration-success";
  const titles = { home: "Banking for what comes next", login: "Log in", register: "Open an account", "verify-email": "Verify your email", "registration-success": "Registration Successful", admin: "Admin Dashboard", dashboard: "Dashboard", transfer: "Transfer Funds", history: "Transaction History", account: "Account Management", statements: "Statements & Documents", support: "Help & Support", profile: "Profile & Security" };
  document.title = `${titles[route]} | Webbank`;
  if (sectionTarget) requestAnimationFrame(() => document.getElementById(sectionTarget)?.scrollIntoView());
  mainNav.classList.remove("open");
  menuToggle.setAttribute("aria-expanded", "false");
}
function resizeAndCompressImage(file, maxSize = 400, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      let width = img.width;
      let height = img.height;
      if (width > maxSize || height > maxSize) {
        const scale = Math.min(maxSize / width, maxSize / height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        },
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load image."));
    };
    img.src = url;
  });
}

async function startSession(user) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session || session.user.id !== user.profile.auth_user_id) {
    localStorage.removeItem(STORAGE.session);
    activeUserCache = null;
    routeTo("login");
    return false;
  }
  activeUserCache = user;
  localStorage.setItem(STORAGE.session, user.email);
  sessionStorage.removeItem(PENDING_REGISTRATION);
  pendingUserCache = null;
  routeTo("dashboard");
  return true;
}

document.addEventListener("click", async (event) => {
  if (event.target.closest("[data-resend-code]")) {
    const message = document.querySelector("#resend-message");
    const email = sessionStorage.getItem(PENDING_REGISTRATION);
    if (!email || !message) return;
    const button = event.target.closest("[data-resend-code]");
    button.disabled = true;
    try {
      const { error } = await supabaseClient.auth.resend({ type: "signup", email });
      if (error) throw error;
      message.className = "form-message verification-resend-message success";
      message.textContent = "A new verification code has been sent.";
    } catch (error) {
      message.className = "form-message verification-resend-message error";
      message.textContent = error.message || "The verification code could not be resent.";
    } finally {
      button.disabled = false;
    }
    return;
  }
  if (event.target.closest("[data-enter-dashboard]")) {
    let user = pendingUserCache;
    try {
      user ||= await pendingRegistrationUser();
    } catch (error) {
      routeTo("login");
      return;
    }
    if (user) await startSession(user);
    else routeTo("login");
    return;
  }
  if (event.target.closest("[data-signout]")) {
    localStorage.removeItem(STORAGE.session);
    activeUserCache = null;
    await supabaseClient.auth.signOut();
    routeTo("login");
    return;
  }
  if (event.target.closest("[data-admin-signout]")) {
    adminUnlocked = false;
    adminUsersCache = [];
    await supabaseClient.auth.signOut();
    routeTo("login");
    return;
  }
  const pendingAction = event.target.closest("[data-pending-transfer-action]");
  if (pendingAction) {
    try {
      adminUsersCache = await reviewPendingTransfer(
        pendingAction.dataset.userEmail,
        pendingAction.dataset.transactionId,
        pendingAction.dataset.pendingTransferAction
      );
      render();
    } catch (error) {
      alert(error.message || "The transfer could not be reviewed.");
    }
    return;
  }
  if (event.target.closest("[data-admin-view]")) {
    const email = event.target.closest("[data-admin-view]").dataset.adminView;
    const user = adminUsersCache.map((row) => row.account_number ? mapUserRow(row) : row).find((row) => row.email === email);
    if (!user) return;
    document.querySelector("#admin-dialog-content").innerHTML = adminDetailsMarkup(user);
    document.querySelector("#admin-details-dialog").showModal();
  }
  const declineNotifyClose = event.target.closest("[data-decline-notify-close]");
  if (declineNotifyClose) {
    try {
      const email = declineNotifyClose.dataset.declineNotifyClose;
      const transactionId = declineNotifyClose.dataset.transactionId;
      await markTransferNotified(email, transactionId);
      closeModal();
      render();
    } catch (error) {
      alert(error.message || "The transfer decline could not be acknowledged.");
    }
    return;
  }
  const receiptModalClose = event.target.closest("[data-receipt-modal-close]");
  if (receiptModalClose) {
    closeModal();
    routeTo(receiptModalClose.dataset.receiptModalClose);
    return;
  }
  const accountAction = event.target.closest("[data-account-action]")?.dataset.accountAction;
  if (accountAction) {
    const user = currentUser();
    if (!user || (accountAction === "close" && user.account.status !== "Active") || (accountAction === "open" && user.account.status === "Active")) return;
    if (accountAction === "open") {
      user.accountNumber = await generateAccountNumber();
      user.profile.accountNumber = user.accountNumber;
      user.account = { accountType: user.profile.accountType || "Checking", currency: user.profile.currency || "USD", balance: 0, status: "Active", transactions: [] };
      user.account.accountNumber = user.accountNumber;
    } else {
      user.account.status = "Closed";
    }
    try {
      await saveUser(user);
    } catch (error) {
      alert(error.message || "The account could not be updated.");
      return;
    }
    render();
  }

  const visibilityButton = event.target.closest("[data-visibility]");
  if (visibilityButton) {
    const type = visibilityButton.dataset.visibility;
    const isPressed = visibilityButton.getAttribute("aria-pressed") === "true";
    const wasHidden = type === "account" ? !isPressed : isPressed;
    const isHidden = !wasHidden;
    const user = currentUser();
    const value = type === "account" ? document.querySelector("[data-account-value]") : document.querySelector("[data-balance-value]");
    if (!user || !value) return;
    value.textContent = isHidden
      ? type === "account" ? `******${user.accountNumber.slice(-4)}` : "••••••"
      : type === "account" ? user.accountNumber : money(user.account.balance, user.account.currency);
    visibilityButton.setAttribute("aria-pressed", String(type === "account" ? !isHidden : isHidden));
    visibilityButton.setAttribute("aria-label", `${isHidden ? "Show" : "Hide"} ${type === "account" ? "account number" : "balance"}`);
  }
});
document.addEventListener("submit", async (event) => {
  if (event.target.id === "auth-form") {
    event.preventDefault();
    const form = event.target;
    const message = form.querySelector("#form-message");
    const formData = new FormData(form);
    let email = String(formData.get("email")).trim().toLowerCase();
    const password = String(formData.get("password"));
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const isRegistration = formData.has("firstName");
    if (isRegistration && password !== formData.get("confirmPassword")) {
      message.className = "form-message error";
      message.textContent = "Those passwords don’t match. Please try again.";
      return;
    }
    if (isRegistration && ![formData.get("phone"), formData.get("kinPhone")].every((phone) => /^[-0-9+(). ]{7,20}$/.test(String(phone)))) {
      message.className = "form-message error";
      message.textContent = "Enter a valid phone number for you and your next of kin.";
      return;
    }
    try {
      let user = null;
      if (isRegistration) {
        const photo = formData.get("passportPhoto");
        const profile = Object.fromEntries([...formData.entries()].filter(([field]) => !["password", "confirmPassword", "passportPhoto"].includes(field)));
        profile.passportPhoto = photo instanceof File && photo.size ? await resizeAndCompressImage(photo) : "";
        const accountNumber = await generateAccountNumber();
        profile.accountNumber = accountNumber;
        const name = `${profile.firstName} ${profile.lastName}`;
        const account = { accountType: profile.accountType, currency: profile.currency, balance: 0, status: "Active", transactions: [] };
        const security = { twoFactor: false, loginAlerts: true };
        const { data: signUpData, error: signUpError } = await supabaseClient.auth.signUp({
          email,
          password,
          options: { data: { name, account_number: accountNumber, profile: { ...profile, passportPhoto: "" }, account, security } }
        });
        if (signUpError) throw signUpError;
        if (!signUpData.user) throw new Error("Registration could not be completed.");
        if (signUpData.user.identities?.length === 0) throw new Error("An account may already exist for this email. Sign in instead.");
        profile.auth_user_id = signUpData.user.id;
        user = {
          email,
          name,
          profile,
          passwordHash: null,
          accountNumber,
          account,
          security,
          createdAt: new Date().toISOString()
        };
        localStorage.removeItem(STORAGE.session);
        sessionStorage.setItem(PENDING_REGISTRATION, user.email);
        pendingUserCache = user;
        if (signUpData.session) {
          await saveUser(user);
          sessionStorage.removeItem(PENDING_PROFILE);
          routeTo("registration-success");
        } else {
          sessionStorage.setItem(PENDING_PROFILE, JSON.stringify({ email, user }));
          routeTo("verify-email");
        }
      } else {
        if (email && !email.includes("@")) {
          const digits = email.replace(/\D/g, "");
          const { data: resolvedEmail, error: acctErr } = await supabaseClient.rpc("get_email_by_account_number", { p_acct: digits });
          if (acctErr || !resolvedEmail) throw new Error("No account found with that account number.");
          email = resolvedEmail;
        }
        const { data: loginData, error: loginError } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (loginError) throw loginError;
        user = await findUser(email);
        const pending = JSON.parse(sessionStorage.getItem(PENDING_PROFILE) || "null");
        if (!user && pending?.email === email) user = pending.user;
        if (!user) throw new Error("Your account profile could not be found. Contact support.");
        user.profile = { ...user.profile, ...(pending?.email === email ? pending.user.profile : {}) };
        user.profile.auth_user_id = loginData.user.id;
        await saveUser(user);
        if (pending?.email === email) sessionStorage.removeItem(PENDING_PROFILE);
        await startSession(user);
      }
    } catch (error) {
      message.className = "form-message error";
      message.textContent = error?.name === "QuotaExceededError"
        ? "This photo could not be uploaded. Choose a smaller image."
        : "Your request could not be completed. Please try again.";
    }
  }

  if (event.target.id === "verification-form") {
    event.preventDefault();
    const form = event.target;
    const message = form.querySelector("#verification-message");
    const code = String(new FormData(form).get("code") || "").trim();
    const email = sessionStorage.getItem(PENDING_REGISTRATION);
    const pending = JSON.parse(sessionStorage.getItem(PENDING_PROFILE) || "null");
    if (!form.checkValidity() || !/^\d{6}$/.test(code)) {
      form.reportValidity();
      if (!/^\d{6}$/.test(code)) {
        message.className = "form-message error";
        message.textContent = "Enter the 6-digit code from your email.";
      }
      return;
    }
    if (!email || pending?.email !== email || !pending.user) {
      message.className = "form-message error";
      message.textContent = "Your registration details have expired. Please register again.";
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const { data, error } = await supabaseClient.auth.verifyOtp({ email, token: code, type: "signup" });
      if (error) throw error;
      if (!data.session || !data.user) throw new Error("Email verification did not complete. Please try again.");
      const user = pending.user;
      user.profile.auth_user_id = data.user.id;
      await saveUser(user);
      sessionStorage.removeItem(PENDING_PROFILE);
      pendingUserCache = user;
      routeTo("registration-success");
    } catch (error) {
      message.className = "form-message error";
      message.textContent = error.message || "The verification code could not be confirmed.";
    } finally {
      button.disabled = false;
    }
  }

  if (event.target.id === "transfer-form") {
    try {
      event.preventDefault();
      const form = event.target;
      const message = form.querySelector("#transfer-message");
      const values = new FormData(form);
      const amount = Math.round(Number(values.get("amount")) * 100) / 100;
      const user = currentUser();
      if (!user) {
        message.textContent = "You must be signed in to submit a transfer.";
        message.className = "form-message error";
        return;
      }
      const data = user.account;
      const availableBalance = Math.max(0, data.balance - pendingDebitTotal(data));
      if (!form.checkValidity()) {
        form.reportValidity();
        message.textContent = "Please fill in all required fields correctly.";
        message.className = "form-message error";
        return;
      }
      if (data.status !== "Active") {
        message.textContent = "Transfers are unavailable while this account is closed.";
        message.className = "form-message error";
        return;
      }
      if (!Number.isFinite(amount) || amount <= 0 || amount > availableBalance) {
        message.textContent = amount > availableBalance ? "Insufficient funds for this transfer." : "Enter an amount greater than zero.";
        message.className = "form-message error";
        return;
      }
      const reference = "REF-" + Math.floor(10000000 + Math.random() * 90000000);
      const now = new Date().toLocaleString();
      const recipientName = String(values.get("recipientName")).trim();
      const pendingTx = {
        id: reference,
        reference,
        recipientName,
        description: "Transfer to " + recipientName,
        type: "Debit",
        date: now,
        amount: -amount,
        note: String(values.get("note")).trim(), recipientAddress: String(values.get("recipientAddress") || "").trim(), recipientCountry: String(values.get("recipientCountry") || "").trim(), recipientPhone: String(values.get("recipientPhone") || "").trim(), bankName: String(values.get("bankName") || "").trim(), transferCurrency: String(values.get("transferCurrency") || data.currency).trim(),
        routingNumber: String(values.get("routingNumber")).trim(),
        accountNumber: String(values.get("recipientAccount")).trim(),
        status: "Pending",
        createdAt: new Date().toISOString()
      };
      data.transactions.unshift(pendingTx);
      await saveUser(user);
      const submittedTransaction = pendingTx;
      const submittedAt = submittedTransaction.date || now;
      form.reset();
      form.querySelector('input[name="amount"]').setAttribute("max", String(Math.max(0, availableBalance - amount)));
      const summary = document.querySelector(".summary-balance");
      if (summary) summary.textContent = money(Math.max(0, availableBalance - amount), data.currency);
      const availableLabel = document.querySelector("#transfer-form .panel-heading span");
      if (availableLabel) availableLabel.textContent = `Available balance: ${money(Math.max(0, availableBalance - amount), data.currency)}`;
      openModal(`
        <div class="receipt-modal-card">
          <div class="receipt-modal-icon pending" aria-hidden="true">⏳</div>
          <h2>Transfer Pending Review</h2>
          <p>Your transfer has been submitted and is awaiting administrator review.</p>
          <table class="receipt-table">
            <tr><th>Status</th><td><span class="status-badge status-pending">Pending</span></td></tr>
            <tr><th>Amount</th><td>${money(amount, submittedTransaction.transferCurrency || data.currency)} (${escapeHTML(submittedTransaction.transferCurrency || data.currency)})</td></tr><tr><th>Recipient Address</th><td>${escapeHTML(submittedTransaction.recipientAddress || "—")}</td></tr><tr><th>Country</th><td>${escapeHTML(submittedTransaction.recipientCountry || "—")}</td></tr><tr><th>Phone Number</th><td>${escapeHTML(submittedTransaction.recipientPhone || "—")}</td></tr><tr><th>Bank Name</th><td>${escapeHTML(submittedTransaction.bankName || "—")}</td></tr>
            <tr><th>Recipient Name</th><td>${escapeHTML(submittedTransaction.recipientName)}</td></tr>
            <tr><th>Bank / Routing Number</th><td>${escapeHTML(submittedTransaction.routingNumber)}</td></tr>
            <tr><th>Account Number</th><td>${escapeHTML(submittedTransaction.accountNumber)}</td></tr>
            <tr><th>Reference / Transaction ID</th><td><code>${escapeHTML(submittedTransaction.reference)}</code></td></tr>
            <tr><th>Date &amp; Time</th><td>${escapeHTML(submittedAt)}</td></tr>
          </table>
          <button class="button" type="button" data-receipt-modal-close="dashboard">Close</button>
        </div>
      `);
    } catch (error) {
      const message = document.querySelector("#transfer-message");
      if (message) {
        message.textContent = error.message || "The transfer could not be submitted. Please try again.";
        message.className = "form-message error";
      } else {
        alert(error.message || "The transfer could not be submitted. Please try again.");
      }
    }
  }

  if (event.target.id === "history-filters") {
    event.preventDefault();
    const filters = new FormData(event.target);
    const account = currentUser().account;
    const filtered = account.transactions.filter((transaction) => {
      const date = transaction.date;
      const type = filters.get("type");
      const typeMatch = type === "all" || (type === "credit" ? transaction.amount > 0 : transaction.amount < 0);
      return typeMatch && (!filters.get("from") || date >= filters.get("from")) && (!filters.get("to") || date <= filters.get("to"));
    });
    document.querySelector("#history-results").innerHTML = historyResults(filtered, account.currency);
    document.querySelector(".history-filters + .activity-head span").textContent = `${filtered.length} matching`;
  }

  if (event.target.id === "password-form") {
    event.preventDefault();
    const form = event.target;
    const message = form.querySelector("#password-message");
    const values = new FormData(form);
    if (!form.checkValidity()) return form.reportValidity();
    if (values.get("newPassword") !== values.get("confirmNewPassword")) {
      message.textContent = "The new passwords don’t match.";
      message.className = "form-message error";
      return;
    }
    const user = currentUser();
    const { error } = await supabaseClient.auth.updateUser({ password: values.get("newPassword") });
    if (error) {
      message.textContent = error.message;
      message.className = "form-message error";
      return;
    }
    form.reset();
    message.textContent = "Password updated successfully.";
    message.className = "form-message success";
  }

  if (event.target.id === "support-form") {
    event.preventDefault();
    const form = event.target;
    if (!form.checkValidity()) return form.reportValidity();
    const values = new FormData(form);
    form.querySelector("#support-message").textContent = "Thanks. Your support request has been received.";
    form.reset();
  }

  if (event.target.id === "admin-login-form") {
    event.preventDefault();
    const form = event.target;
    const message = form.querySelector("#admin-login-message");
    const values = new FormData(form);
    try {
      const { data, error } = await supabaseClient.auth.signInWithPassword({
        email: String(values.get("email")).trim().toLowerCase(),
        password: String(values.get("password"))
      });
      if (error) throw error;
      if (data.user?.app_metadata?.role !== "admin") {
        await supabaseClient.auth.signOut();
        throw new Error("This account does not have administrator access.");
      }
      adminUnlocked = true;
      adminErrorMessage = "";
      localStorage.removeItem(STORAGE.session);
      activeUserCache = null;
      adminUsersCache = await fetchAdminUsers();
      render();
    } catch (error) {
      adminErrorMessage = error.message || "Administrator access could not be verified.";
      message.textContent = adminErrorMessage;
      message.className = "form-message error";
    }
  }

  if (event.target.id === "admin-control-form") {
    event.preventDefault();
    const form = event.target;
    const submitter = event.submitter;
    const action = submitter?.value;
    const email = form.dataset.userEmail;
    const values = new FormData(form);
    const amount = Number(values.get("amount"));
    const description = String(values.get("description") || "").trim();
    if (["credit", "debit"].includes(action) && (!Number.isFinite(amount) || amount <= 0)) {
      alert("Enter an amount greater than zero.");
      return;
    }
    try {
      adminUsersCache = await manageAdminAccount(email, action, amount, description);
      const updatedUser = adminUsersCache.map((row) => row.account_number ? mapUserRow(row) : row).find((user) => user.email === email);
      document.querySelector("#admin-users-body").innerHTML = adminUserRows(adminUsersCache.map((row) => row.account_number ? mapUserRow(row) : row));
      document.querySelector("#admin-dialog-content").innerHTML = adminDetailsMarkup(updatedUser);
    } catch (error) {
      alert(error.message || "The account could not be updated.");
    }
  }
});

document.addEventListener("change", async (event) => {
  if (event.target.matches("[data-security]")) {
    const user = currentUser();
    user.security[event.target.dataset.security] = event.target.checked;
    try {
      await saveUser(user);
      document.querySelector("#security-message").textContent = "Security preference saved.";
    } catch (error) {
      document.querySelector("#security-message").textContent = error.message;
      event.target.checked = !event.target.checked;
    }
  }
  if (event.target.matches("#history-filters")) document.querySelector("#history-filters").requestSubmit();
});

document.addEventListener("input", (event) => {
  if (event.target.id === "admin-search") {
    const query = event.target.value.trim().toLowerCase();
    const users = adminUsersCache.map((row) => row.account_number ? mapUserRow(row) : row).filter((user) => `${user.name} ${user.email} ${user.accountNumber}`.toLowerCase().includes(query));
    document.querySelector("#admin-users-body").innerHTML = adminUserRows(users);
  }
});

document.addEventListener("reset", (event) => {
  if (event.target.id === "history-filters") {
    requestAnimationFrame(() => {
      const account = currentUser().account;
      document.querySelector("#history-results").innerHTML = historyResults(account.transactions, account.currency);
      document.querySelector(".history-filters + .activity-head span").textContent = `${account.transactions.length} total`;
    });
  }
});

menuToggle.addEventListener("click", () => {
  const expanded = menuToggle.getAttribute("aria-expanded") === "true";
  menuToggle.setAttribute("aria-expanded", String(!expanded));
  mainNav.classList.toggle("open", !expanded);
});

window.addEventListener("hashchange", render);
render();



;(function () {
  if (window.__webbankEnhancementsInstalled) return;
  window.__webbankEnhancementsInstalled = true;

  const eyeOpenSVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="pointer-events:none"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const eyeClosedSVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="pointer-events:none"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function attachPasswordToggles() {
    document.querySelectorAll('input[type="password"]').forEach(inp => {
      if (inp.dataset.pwEnhanced) return;
      inp.dataset.pwEnhanced = "1";
      const wrap = document.createElement("div");
      wrap.className = "pw-toggle-wrap";
      inp.parentNode.insertBefore(wrap, inp);
      wrap.appendChild(inp);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pw-toggle-btn";
      btn.setAttribute("aria-label", "Toggle password visibility");
      btn.innerHTML = eyeOpenSVG;
      wrap.appendChild(btn);
    });
  }

  document.addEventListener("click", function (e) {
    const btn = e.target.closest(".pw-toggle-btn");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const wrap = btn.closest(".pw-toggle-wrap");
    const inp = wrap ? wrap.querySelector("input") : null;
    if (!inp) return;
    const isHidden = inp.type === "password";
    inp.type = isHidden ? "text" : "password";
    btn.innerHTML = isHidden ? eyeClosedSVG : eyeOpenSVG;
  }, true);

  document.addEventListener("change", function (e) {
    const inp = e.target;
    if (!inp || inp.type !== "file" || !inp.files || !inp.files[0] || inp.dataset.compressedReady) return;
    const file = inp.files[0];
    if (!file.type.startsWith("image/") && !/\.(heic|heif|jpg|jpeg|png|webp|gif|bmp)$/i.test(file.name)) return;
    if (file.size <= 1200000) return;

    e.stopImmediatePropagation();
    const reader = new FileReader();
    reader.onload = function (ev) {
      const img = new Image();
      img.onload = function () {
        const maxDim = 480;
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; }
          else { w = Math.round((w * maxDim) / h); h = maxDim; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        canvas.toBlob(function (blob) {
          if (!blob) return;
          const dt = new DataTransfer();
          dt.items.add(new File([blob], "photo.jpg", { type: "image/jpeg" }));
          inp.files = dt.files;
          inp.dataset.compressedReady = "1";
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          setTimeout(() => { delete inp.dataset.compressedReady; }, 200);
        }, "image/jpeg", 0.82);
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  }, true);

  function enhanceFileInputs() {
    document.querySelectorAll('input[type="file"]').forEach(inp => {
      inp.setAttribute("accept", "image/*");
    });
  }

  function wrapSignIn() {
    const sb = window.__wbSupabase || window.supabaseClient || window.sb;
    if (!sb || !sb.auth || !sb.auth.signInWithPassword || sb.auth.__wbWrapped) return;
    const orig = sb.auth.signInWithPassword.bind(sb.auth);
    sb.auth.signInWithPassword = async function (creds) {
      let email = creds && creds.email ? String(creds.email).trim() : "";
      if (email && !email.includes("@")) {
        const digits = email.replace(/\D/g, "");
        const { data: resolvedEmail, error } = await sb.rpc("get_email_by_account_number", { p_acct: digits });
        if (error || !resolvedEmail) {
          return { data: { user: null, session: null }, error: { message: "No account found with that account number." } };
        }
        email = resolvedEmail;
      }
      return orig({ ...creds, email });
    };
    sb.auth.__wbWrapped = true;
  }

  const initAll = () => {
    attachPasswordToggles();
    enhanceFileInputs();
    wrapSignIn();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }
  new MutationObserver(initAll).observe(document.documentElement, { childList: true, subtree: true });
})();



