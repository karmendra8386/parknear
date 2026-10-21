"use strict";
/* ParkNextDoor — neighborhood event parking.
   Two modes:
   - Live Mode: PARK_CONFIG has a Supabase URL + anon key. Events, offers and
     claims are rows in a shared database; links carry only an event id.
   - Link Mode (default): no server. Event/offer/guest data travels inside
     the share links themselves (base64url JSON) and via WhatsApp. The host
     dashboard is stored in the host's own browser (localStorage).          */
const CFG = window.PARK_CONFIG || {};
const LIVE = Boolean(CFG.supabaseUrl && CFG.supabaseAnonKey);
const $app = document.getElementById("app");
document.getElementById("mode-line").textContent = LIVE
  ? "Live Mode: offers and claims sync for everyone."
  : "Link Mode: no server — offers come back to the host through the links below.";

// ---------- helpers ----------
const enc = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const dec = (s) => JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/")))));
const uid = () => Math.random().toString(36).slice(2, 9);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const passcode = () => String(Math.floor(1000 + Math.random() * 9000));
function haversineMi(aLat, aLng, bLat, bLng) {
  if ([aLat, aLng, bLat, bLng].some((v) => v === null || v === undefined || Number.isNaN(+v))) return null;
  const R = 3958.8, dLa = (bLat - aLat) * Math.PI / 180, dLo = (bLng - aLng) * Math.PI / 180;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) * 100) / 100;
}
const distLabel = (d) => d === null ? "distance unknown" : d < 0.2 ? `${Math.round(d * 5280)} ft away` : `${d} mi away`;
// Address search-as-you-type (ArcGIS suggestions — the same service that can
// find new-subdivision streets; Nominatim as fallback)
async function suggestAddresses(q) {
  q = (q || "").trim();
  if (q.length < 4) return [];
  try {
    const r = await fetch("https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/suggest?f=json&countryCode=USA&maxSuggestions=6&text=" + encodeURIComponent(q));
    const j = await r.json();
    const s = (j.suggestions || []).map((x) => x.text).filter(Boolean);
    if (s.length) return s;
  } catch {}
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=us&q=" + encodeURIComponent(q));
    const j = await r.json();
    return j.map((x) => x.display_name);
  } catch { return []; }
}
function attachAutocomplete(input) {
  if (!input || input.dataset.ac) return; input.dataset.ac = "1";
  const wrap = document.createElement("div"); wrap.className = "ac-wrap";
  input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
  const list = document.createElement("div"); list.className = "ac-list"; list.style.display = "none"; wrap.appendChild(list);
  let timer = null, seq = 0;
  const hide = () => { list.style.display = "none"; };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const my = ++seq;
      const items = await suggestAddresses(input.value);
      if (my !== seq || document.activeElement !== input) return;
      if (!items.length) { hide(); return; }
      list.innerHTML = items.map((t) => `<div class="ac-item">${esc(t)}</div>`).join("");
      list.querySelectorAll(".ac-item").forEach((el, i) => el.addEventListener("mousedown", (ev) => { ev.preventDefault(); input.value = items[i]; hide(); }));
      list.style.display = "block";
    }, 300);
  });
  input.addEventListener("blur", () => setTimeout(hide, 150));
  input.setAttribute("autocomplete", "off");
}
async function geocode(address) {
  // 1) ArcGIS World geocoder — far better US house-number coverage than
  // OpenStreetMap for new subdivisions (verified: 25500 Grassy Meadow Dr,
  // Aldie VA scores 100 on ArcGIS, not found at all on Nominatim/Census).
  try {
    const r = await fetch("https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&maxLocations=1&singleLine=" + encodeURIComponent(address));
    const j = await r.json();
    if (j.candidates && j.candidates.length && j.candidates[0].score >= 80) {
      return { lat: j.candidates[0].location.y, lng: j.candidates[0].location.x };
    }
  } catch {}
  // 2) OpenStreetMap Nominatim fallback.
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(address), { headers: { Accept: "application/json" } });
    const j = await r.json();
    if (j.length) return { lat: +j[0].lat, lng: +j[0].lon };
  } catch {}
  return null;
}
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
};
const myEvents = () => store.get("parknear_events", []);
const saveEvent = (ev) => { const all = myEvents().filter((e) => e.id !== ev.id); all.push(ev); store.set("parknear_events", all); };
const offersFor = (id) => store.get("parknear_offers_" + id, []);
const saveOffers = (id, o) => store.set("parknear_offers_" + id, o);
const claimsFor = (id) => store.get("parknear_claims_" + id, []);
const saveClaims = (id, c) => store.set("parknear_claims_" + id, c);
const base = () => location.origin + location.pathname;

// ---------- Supabase REST (Live Mode only) ----------
async function sb(path, opts = {}) {
  const r = await fetch(CFG.supabaseUrl.replace(/\/$/, "") + "/rest/v1/" + path, {
    ...opts,
    headers: { apikey: CFG.supabaseAnonKey, Authorization: "Bearer " + CFG.supabaseAnonKey, "Content-Type": "application/json", Prefer: "return=representation", ...(opts.headers || {}) }
  });
  if (!r.ok) throw new Error("Database error " + r.status);
  return r.status === 204 ? null : r.json();
}
const db = {
  async createEvent(ev) { if (!LIVE) return ev; const [row] = await sb("events", { method: "POST", body: JSON.stringify(ev) }); return row; },
  async getEvent(id) { if (!LIVE) return null; const rows = await sb("events?id=eq." + encodeURIComponent(id) + "&select=*"); return rows[0] || null; },
  async addOffer(o) { if (!LIVE) return o; const [row] = await sb("offers", { method: "POST", body: JSON.stringify(o) }); return row; },
  async listOffers(eventId) { if (!LIVE) return offersFor(eventId); return sb("offers?event_id=eq." + encodeURIComponent(eventId) + "&select=*&order=created_at.asc"); },
  async setOfferStatus(id, status) { if (!LIVE) return; return sb("offers?id=eq." + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify({ status }) }); },
  async addClaim(c) { if (!LIVE) return c; const [row] = await sb("claims", { method: "POST", body: JSON.stringify(c) }); return row; },
  async listClaims(eventId) { if (!LIVE) return claimsFor(eventId); return sb("claims?event_id=eq." + encodeURIComponent(eventId) + "&select=*&order=created_at.asc"); },
  async getOffer(id) { if (!LIVE) return null; const rows = await sb("offers?id=eq." + encodeURIComponent(id) + "&select=*"); return rows[0] || null; },
  async listAllEvents() { if (!LIVE) return myEvents(); return sb("events?select=*&order=party_date.desc,created_at.desc"); },
  async listEventsByEmail(email) { if (!LIVE) return myEvents().filter((e) => (e.email || "").toLowerCase() === String(email).toLowerCase()); return sb("events?email=ilike." + encodeURIComponent(email) + "&select=*&order=party_date.desc,created_at.desc"); },
  async deleteEvent(id) { if (!LIVE) return; return sb("events?id=eq." + encodeURIComponent(id), { method: "DELETE" }); },
  async deleteOffer(id) { if (!LIVE) return; return sb("offers?id=eq." + encodeURIComponent(id), { method: "DELETE" }); },
  async deleteClaim(id) { if (!LIVE) return; return sb("claims?id=eq." + encodeURIComponent(id), { method: "DELETE" }); },
  async setVerification(ev, mode) { ev.verification = mode; saveEvent(ev); if (!LIVE) return; return sb("events?id=eq." + encodeURIComponent(ev.id), { method: "PATCH", body: JSON.stringify({ verification: mode }) }); },
  async setEventPin(ev, hash) { ev.host_pin_hash = hash; saveEvent(ev); if (!LIVE) return; return sb("events?id=eq." + encodeURIComponent(ev.id), { method: "PATCH", body: JSON.stringify({ host_pin_hash: hash }) }); },
  // One host PIN per host, keyed by email (hosts table, migration v5).
  async getHost(email) { if (!LIVE || !email) return null; const rows = await sb("hosts?email=eq." + encodeURIComponent(String(email).trim().toLowerCase()) + "&select=*"); return rows[0] || null; },
  async saveHostPin(email, hash) { if (!LIVE) return; const em = String(email).trim().toLowerCase(); const ex = await db.getHost(em); if (ex) await sb("hosts?email=eq." + encodeURIComponent(em), { method: "PATCH", body: JSON.stringify({ pin_hash: hash, reset_hash: null, reset_expires: null, updated_at: new Date().toISOString() }) }); else await sb("hosts", { method: "POST", body: JSON.stringify({ email: em, pin_hash: hash }) }); },
  async setHostPinEverywhere(email, hash) { await db.saveHostPin(email, hash); if (!LIVE) return; await sb("events?email=ilike." + encodeURIComponent(email), { method: "PATCH", body: JSON.stringify({ host_pin_hash: hash }) }); },
  async setHostReset(email, hash, expiresIso) { if (!LIVE) return; return sb("hosts?email=eq." + encodeURIComponent(String(email).trim().toLowerCase()), { method: "PATCH", body: JSON.stringify({ reset_hash: hash, reset_expires: expiresIso }) }); }
};
// Emailed details: sent via EmailJS when configured in config.js
// (window.PARK_CONFIG.emailjs = {publicKey, serviceId, templateId}).
// Until then the confirmation screens offer a one-tap "email it to myself"
// mailto button with the same details, and all emails are stored.
async function emailDetails(to, toName, subject, message) {
  const ej = CFG.emailjs;
  if (!ej || !ej.publicKey || !to) return false;
  try {
    const r = await fetch("https://api.emailjs.com/api/v1.0/email/send", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service_id: ej.serviceId, template_id: ej.templateId, user_id: ej.publicKey,
        template_params: { to_email: to, to_name: toName || "", subject, message } }) });
    return r.ok;
  } catch { return false; }
}
const mailtoBtn = (to, subject, body) => to ? `<a class="btn secondary" href="mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}">📧 Email these details to myself</a>` : "";

// Emails for a lock/unlock: the neighbor always hears about it; on a LOCK the
// host also gets a confirmation carrying the guest link to share.
function notifyLockChange(ev, o, status) {
  if (!ev || !o) return;
  if (o.email) {
    if (status === "locked") emailDetails(o.email, o.neighbor_name, `Your parking spot was accepted — ${ev.party_date}`,
      `${ev.host_name} accepted your spot at ${o.address} for the event on ${ev.party_date} (${ev.time_from}–${ev.time_to}). Your spot is now locked in — guests can claim it, and you'll get another email with the guest's name and car when someone does.\nYour offer page: ${base()}#/o/${o.id}`);
    else emailDetails(o.email, o.neighbor_name, `Your parking spot was released — ${ev.party_date}`,
      `${ev.host_name} released your spot at ${o.address} for the event on ${ev.party_date}, so it's no longer offered to guests. You don't need to do anything.\nYour offer page: ${base()}#/o/${o.id}`);
  }
  if (status === "locked" && ev.email) {
    emailDetails(ev.email, ev.host_name, `Spot locked for your event — ${ev.party_date} · share your guest link`,
      `Hi ${ev.host_name}, you locked ${o.neighbor_name}'s spot at ${o.address} (${o.spots} spot${o.spots === 1 ? "" : "s"}) for your event on ${ev.party_date} (${ev.time_from}–${ev.time_to}).\n\nSend this link to your guests so they can claim a spot:\n${base()}#/g/${ev.id}\n\nThe same guest link is also on your host dashboard:\n${base()}#/host/${ev.id}`);
  }
}

// Forgot-PIN flow: email a 6-digit code (hashed at rest, 30-min expiry), then
// the host chooses a new PIN, which updates the host record AND all their events.
function renderPinReset(box, presetEmail, onSuccess) {
  if (!box) return;
  box.innerHTML = `<div class="spot"><strong>Reset your host PIN by email</strong>
    <label>Your host email</label><input id="rst-email" type="email" value="${esc(presetEmail || "")}" placeholder="you@example.com">
    <p><button type="button" class="secondary" id="rst-send">Email me a reset code →</button></p>
    <div id="rst-step2" style="display:none">
      <label>6-digit code from the email</label><input id="rst-code" inputmode="numeric" maxlength="6" style="max-width:180px">
      <label>New PIN (4–8 digits)</label><input id="rst-new" type="password" inputmode="numeric" maxlength="8" style="max-width:180px">
      <p><button type="button" id="rst-apply">Set new PIN →</button></p>
    </div>
    <p class="muted" id="rst-msg"></p></div>`;
  const msg = box.querySelector("#rst-msg");
  box.querySelector("#rst-send").addEventListener("click", async () => {
    const em = box.querySelector("#rst-email").value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { msg.textContent = "Enter a valid email."; return; }
    const host = await db.getHost(em).catch(() => null);
    if (!host) { msg.textContent = "No host PIN found for that email — a PIN is created with your first event."; return; }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    try { await db.setHostReset(em, await sha256Hex(code), new Date(Date.now() + 30 * 60000).toISOString()); } catch (e) { msg.textContent = e.message; return; }
    await emailDetails(em, "", "Your ParkNextDoor PIN reset code", `Your host PIN reset code is: ${code}\n\nIt expires in 30 minutes. Enter it on the reset screen to choose a new PIN.\nIf you didn't ask for this, ignore this email — your PIN stays the same.`);
    box.querySelector("#rst-step2").style.display = "";
    msg.textContent = "Code sent — check your email (it can take a minute).";
  });
  box.querySelector("#rst-apply").addEventListener("click", async () => {
    const em = box.querySelector("#rst-email").value.trim();
    const code = box.querySelector("#rst-code").value.trim();
    const newPin = box.querySelector("#rst-new").value.trim();
    if (!/^\d{4,8}$/.test(newPin)) { msg.textContent = "New PIN must be 4–8 digits."; return; }
    const host = await db.getHost(em).catch(() => null);
    if (!host || !host.reset_hash) { msg.textContent = "Ask for a reset code first."; return; }
    if (new Date(host.reset_expires).getTime() < Date.now()) { msg.textContent = "That code has expired — ask for a new one."; return; }
    if ((await sha256Hex(code)) !== host.reset_hash) { msg.textContent = "Wrong code — check the email and try again."; return; }
    try { await db.setHostPinEverywhere(em, await sha256Hex(newPin)); } catch (e) { msg.textContent = e.message; return; }
    msg.textContent = "✓ PIN updated for all your events.";
    if (onSuccess) onSuccess(em);
  });
}

// ---------- map ----------
let mapObj = null;
// After a phone rotation or window resize, Leaflet needs a nudge or it leaves
// grey bands where the map used to end.
let __rszT = null;
window.addEventListener("resize", () => { clearTimeout(__rszT); __rszT = setTimeout(() => { try { if (mapObj) mapObj.invalidateSize(); } catch {} }, 250); });
function drawMap(elId, points) {
  const el = document.getElementById(elId);
  if (!el || !window.L || !points.length) return;
  if (mapObj) { mapObj.remove(); mapObj = null; }
  mapObj = L.map(elId).setView([points[0].lat, points[0].lng], 16);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap contributors" }).addTo(mapObj);
  const bounds = [];
  points.forEach((p) => {
    L.marker([p.lat, p.lng]).addTo(mapObj).bindPopup(esc(p.label));
    bounds.push([p.lat, p.lng]);
  });
  if (bounds.length > 1) mapObj.fitBounds(bounds, { padding: [30, 30] });
}

// ---------- views ----------
function homeView() {
  const savedNames = [...new Set(myEvents().map((e) => e.host_name).filter(Boolean))];
  $app.innerHTML = `
  <div class="card"><div class="big">Having an event? Borrow driveway spots from your neighbors.</div>
  <p class="muted">Create an event, post one link in your WhatsApp group, neighbors offer spots, you lock the closest ones, guests claim them with their name and car details. No app to install, no account to create.</p></div>
  <div class="card"><h2>1 · Host — create your event</h2>
  <form id="ev-form">
    <label>Your name</label>${savedNames.length ? `<select id="f-host-sel">${savedNames.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("")}<option value="__new">➕ New name…</option></select><input id="f-host" placeholder="Enter your name" style="display:none">` : `<input id="f-host" required placeholder="Enter your name">`}
    <label>Your home address (event location)</label><input id="f-addr" required placeholder="Street, City, State ZIP">
    <div class="row">
      <div><label>Date</label><input id="f-date" type="date" required></div>
      <div><label>Parking spots needed</label><input id="f-needed" type="number" min="1" max="100" placeholder="Enter number" required></div>
    </div>
    <div class="row">
      <div><label>Guests arrive from</label><input id="f-from" type="time" required></div>
      <div><label>Until</label><input id="f-to" type="time" required></div>
    </div>
    <label>Your email (required — your event details are sent here for reference)</label><input id="f-email" type="email" required placeholder="you@example.com">
    <label>Your mobile (optional — neighbors/guests only see it if you share it)</label><input id="f-phone" type="tel" placeholder="Optional">
    <p class="muted">Simple verification, no passcodes: guests claim with their name and car (color + make & model), so the neighbor and you can recognize exactly who is parking — nothing for anyone to remember or share.</p>
    <div id="pin-row"><label>Host PIN (required — ONE PIN for all your events; only someone with it can open your host dashboards and accept offers)</label><input id="f-pin" type="password" inputmode="numeric" maxlength="8" required placeholder="4–8 digits — pick one you'll remember"></div>
    <p class="muted" id="pin-note" style="display:none">✓ You already have a host PIN for this email — this event will use the same PIN, no need to set it again.</p>
    <label>Note for neighbors (optional)</label><textarea id="f-notes" rows="2" placeholder="e.g. Diwali event, thank you! Please keep the garage side clear."></textarea>
    <p><button type="submit">Create event &amp; get my neighbor link →</button></p>
    <p class="muted" id="ev-msg"></p>
  </form></div>`;
  attachAutocomplete(document.getElementById("f-addr"));
  // If this email already has a host PIN, don't ask for one again.
  const emailEl = document.getElementById("f-email");
  const checkHostPin = async () => {
    const em = emailEl.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return;
    const h = await db.getHost(em).catch(() => null);
    document.getElementById("pin-row").style.display = h ? "none" : "";
    document.getElementById("pin-note").style.display = h ? "" : "none";
    document.getElementById("f-pin").required = !h;
  };
  emailEl.addEventListener("blur", checkHostPin);
  emailEl.addEventListener("change", checkHostPin);
  const hostSel = document.getElementById("f-host-sel");
  if (hostSel) hostSel.addEventListener("change", () => {
    const inp = document.getElementById("f-host");
    const isNew = hostSel.value === "__new";
    inp.style.display = isNew ? "" : "none";
    inp.required = isNew;
    if (isNew) inp.focus();
  });
  document.getElementById("ev-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("ev-msg");
    const hostName = hostSel && hostSel.value !== "__new" ? hostSel.value : document.getElementById("f-host").value.trim();
    if (!hostName) { msg.textContent = "Please enter your name."; return; }
    msg.textContent = "Finding your address on the map…";
    const addr = document.getElementById("f-addr").value.trim();
    let geo = null; try { geo = await geocode(addr); } catch {}
    if (!geo) { msg.textContent = "Could not pin that address. Check the spelling (add city, state and ZIP) and try again."; return; }
    const emailVal = document.getElementById("f-email").value.trim();
    const hostRec = await db.getHost(emailVal).catch(() => null);
    let pinHash;
    if (hostRec) pinHash = hostRec.pin_hash;
    else {
      const pinVal = document.getElementById("f-pin").value.trim();
      if (!/^\d{4,8}$/.test(pinVal)) { msg.textContent = "Your host PIN must be 4–8 digits."; return; }
      pinHash = await sha256Hex(pinVal);
    }
    const ev = { id: uid(), host_name: hostName, address: addr, lat: geo.lat, lng: geo.lng,
      party_date: document.getElementById("f-date").value, needed: +document.getElementById("f-needed").value,
      time_from: document.getElementById("f-from").value, time_to: document.getElementById("f-to").value,
      email: emailVal, verification: "name",
      host_pin_hash: pinHash,
      phone: document.getElementById("f-phone").value.trim(), notes: document.getElementById("f-notes").value.trim() };
    try { await db.createEvent(ev); } catch (err) { msg.textContent = err.message; return; }
    if (!hostRec) { try { await db.saveHostPin(emailVal, pinHash); } catch {} }
    saveEvent(ev);
    sessionStorage.setItem("parknear_host_" + ev.id, "1");
    emailDetails(ev.email, ev.host_name, `Your ParkNextDoor event — ${ev.party_date}`,
      `Hi ${ev.host_name}, your event is created.\nWhen: ${ev.party_date}, ${ev.time_from}–${ev.time_to}\nWhere: ${ev.address}\nSpots needed: ${ev.needed}\nShare this link with neighbors: ${offerLink(ev)}\nYour private host dashboard (do not share): ${base()}#/host/${ev.id}`);
    location.hash = "#/host/" + ev.id;
  });
}

async function resolveEvent(ref) {
  // ref is either a Live-Mode event id, or Link-Mode encoded event data
  if (LIVE) { const ev = await db.getEvent(ref); if (ev) return ev; }
  try { const ev = dec(ref); if (ev && ev.id) { saveEvent(ev); return ev; } } catch {}
  return myEvents().find((e) => e.id === ref) || null;
}
const offerLink = (ev) => LIVE ? `${base()}#/e/${ev.id}` : `${base()}#/e/${enc(ev)}`;
const guestLink = (ev, spots) => LIVE ? `${base()}#/g/${ev.id}` : `${base()}#/g/${enc({ ev, spots })}`;
const waShare = (text) => "https://wa.me/?text=" + encodeURIComponent(text);

// Host home (#/host with no event id): the host "signs in" with the email used
// at event creation and sees every event made with that email, on any device.
async function hostHomeView() {
  const saved = (localStorage.getItem("parknear_my_email") || "").trim();
  if (!saved) {
    $app.innerHTML = `<div class="card"><div class="big">👋 Host dashboard</div>
      <p class="muted">Enter the email you used when creating your events — you'll see all of them here, past and upcoming, from any device.</p>
      <label>Your email</label><input id="my-email" type="email" placeholder="you@example.com" style="max-width:340px">
      <p><button id="my-go">See my events →</button></p><p class="muted" id="my-msg"></p></div>`;
    document.getElementById("my-go").addEventListener("click", () => {
      const v = document.getElementById("my-email").value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { document.getElementById("my-msg").textContent = "Please enter a valid email address."; return; }
      localStorage.setItem("parknear_my_email", v); hostHomeView();
    });
    return;
  }
  $app.innerHTML = `<div class="card"><p class="muted">Loading your events…</p></div>`;
  const events = await db.listEventsByEmail(saved);
  const hostRec = await db.getHost(saved).catch(() => null);
  const today = new Date().toLocaleDateString("en-CA");
  const enriched = [];
  for (const ev of events) {
    const offers = await db.listOffers(ev.id);
    const claims = await db.listClaims(ev.id);
    enriched.push({ ev, offers: offers.length, locked: offers.filter((o) => o.status === "locked").length, claims: claims.length });
  }
  const card = ({ ev, offers, locked, claims }) => `<div class="spot"><span class="badge">${esc(ev.party_date)} · ${esc(ev.time_from)}–${esc(ev.time_to)}</span> <strong>${esc(ev.host_name)}'s event</strong><br>
    <span class="muted">${esc(ev.address)} · needs ${ev.needed} spots · ${offers} offer(s) · ${locked} locked · ${claims} claim(s)</span><br>
    <a class="btn" href="#/host/${ev.id}">Open dashboard</a> <a class="btn secondary" href="#/e/${ev.id}">Neighbor link</a> <a class="btn secondary" href="#/g/${ev.id}">Guest link</a></div>`;
  const up = enriched.filter((x) => x.ev.party_date >= today).sort((a, b) => a.ev.party_date.localeCompare(b.ev.party_date));
  const past = enriched.filter((x) => x.ev.party_date < today);
  $app.innerHTML = `<div class="card"><div class="big">👋 Your events</div>
    <p class="muted">Signed in as <strong>${esc(saved)}</strong> — every event created with this email, on any device. Opening a dashboard still asks for that event's host PIN.</p>
    <p><button class="secondary" id="my-switch">Use a different email</button> <a class="btn" href="#/">+ Create a new event</a></p></div>
    <div class="card"><h2>🔐 Your host PIN</h2>
    ${hostRec ? `<p class="muted">One PIN protects the dashboards of ALL your events — change it here and it updates everywhere.</p>
      <div class="row"><div><label>Current PIN</label><input id="hh-cur" type="password" inputmode="numeric" maxlength="8"></div>
      <div><label>New PIN (4–8 digits)</label><input id="hh-new" type="password" inputmode="numeric" maxlength="8"></div></div>
      <p><button class="secondary" id="hh-change">Change PIN</button> <a href="#" id="hh-forgot">Forgot PIN? Reset by email →</a></p><div id="hh-forgot-box"></div>`
    : `<p class="muted">You haven't set a host PIN yet. Set one now — it protects all your events, and you won't be asked to set one per event again.</p>
      <label>Host PIN (4–8 digits)</label><input id="hh-new" type="password" inputmode="numeric" maxlength="8" style="max-width:220px">
      <p><button class="secondary" id="hh-set">Set my host PIN</button></p>`}
    <p class="muted" id="hh-msg"></p></div>
    <div class="card"><h2>Upcoming (${up.length})</h2>${up.length ? up.map(card).join("") : `<p class="muted">No upcoming events.</p>`}</div>
    <div class="card"><h2>Past (${past.length})</h2>${past.length ? past.map(card).join("") : `<p class="muted">No past events.</p>`}</div>`;
  document.getElementById("my-switch").addEventListener("click", () => { localStorage.removeItem("parknear_my_email"); hostHomeView(); });
  const hhMsg = document.getElementById("hh-msg");
  const hhSet = document.getElementById("hh-set");
  if (hhSet) hhSet.addEventListener("click", async () => {
    const v = document.getElementById("hh-new").value.trim();
    if (!/^\d{4,8}$/.test(v)) { hhMsg.textContent = "PIN must be 4–8 digits."; return; }
    try { await db.setHostPinEverywhere(saved, await sha256Hex(v)); } catch (e) { hhMsg.textContent = e.message; return; }
    hostHomeView();
  });
  const hhChange = document.getElementById("hh-change");
  if (hhChange) hhChange.addEventListener("click", async () => {
    const cur = document.getElementById("hh-cur").value.trim();
    const v = document.getElementById("hh-new").value.trim();
    const hostNow = await db.getHost(saved).catch(() => null);
    if (!hostNow || (await sha256Hex(cur)) !== hostNow.pin_hash) { hhMsg.textContent = "Current PIN doesn't match."; return; }
    if (!/^\d{4,8}$/.test(v)) { hhMsg.textContent = "New PIN must be 4–8 digits."; return; }
    try { await db.setHostPinEverywhere(saved, await sha256Hex(v)); } catch (e) { hhMsg.textContent = e.message; return; }
    hostHomeView();
  });
  const hhForgot = document.getElementById("hh-forgot");
  if (hhForgot) hhForgot.addEventListener("click", (e) => { e.preventDefault(); renderPinReset(document.getElementById("hh-forgot-box"), saved, () => hostHomeView()); });
}

async function hostView(ref) {
  const events = myEvents();
  const ev = ref ? events.find((e) => e.id === ref) || await resolveEvent(ref) : events[events.length - 1];
  if (!ev) { $app.innerHTML = `<div class="card"><h2>Host dashboard</h2><p>No event found. If you're the host, open the dashboard from the device where you created the event, or create a new one.</p><p><a class="btn" href="#/">Create an event</a></p></div>`; return; }
  if (ev.host_pin_hash && sessionStorage.getItem("parknear_host_" + ev.id) !== "1") {
    $app.innerHTML = `<div class="card"><div class="big">🔐 Host sign-in</div>
      <p>This event's host dashboard is protected by a host PIN. Enter the PIN to manage the event and accept offers.</p>
      <input id="host-pin" type="password" inputmode="numeric" maxlength="8" placeholder="Host PIN" style="max-width:220px">
      <p><button id="host-pin-go">Unlock dashboard →</button></p><p class="muted" id="host-pin-msg"></p>
      <p><a href="#" id="host-forgot">Forgot PIN? Reset it by email →</a></p><div id="forgot-box"></div></div>`;
    document.getElementById("host-pin-go").addEventListener("click", async () => {
      const v = document.getElementById("host-pin").value.trim();
      if ((await sha256Hex(v)) === ev.host_pin_hash) { sessionStorage.setItem("parknear_host_" + ev.id, "1"); hostView(ev.id); }
      else document.getElementById("host-pin-msg").textContent = "Wrong PIN — only the host can open this dashboard.";
    });
    document.getElementById("host-forgot").addEventListener("click", (e) => { e.preventDefault(); renderPinReset(document.getElementById("forgot-box"), ev.email || "", () => { sessionStorage.setItem("parknear_host_" + ev.id, "1"); hostView(ev.id); }); });
    return;
  }
  let offers = await db.listOffers(ev.id);
  offers = offers.map((o) => ({ ...o, dist: haversineMi(ev.lat, ev.lng, o.lat, o.lng) })).sort((a, b) => (a.dist ?? 99) - (b.dist ?? 99));
  const claims = await db.listClaims(ev.id);
  const locked = offers.filter((o) => o.status === "locked");
  const lockedSpots = locked.reduce((n, o) => n + (o.spots || 1), 0);
  const spots = locked.flatMap((o) => Array.from({ length: o.spots || 1 }, (_, i) => ({
    offer_id: o.id, neighbor: o.neighbor_name, address: o.address, lat: o.lat, lng: o.lng,
    label: (o.spots > 1 ? `Spot ${i + 1} of ${o.spots}` : "Driveway spot"), code: o.code || (o.code = passcode())
  })));
  if (LIVE) { /* codes persist via claims in Live Mode; Link Mode regenerates deterministically per session */ }
  saveOffers(ev.id, offers);
  const assignRows = spots.map((s) => {
    const c = claims.find((x) => x.address === s.address && x.spot_label === s.label);
    return `<div class="spot">🚗 <strong>${esc(s.address)}</strong> · ${esc(s.label)}<br>
      <span class="muted">Neighbor:</span> <strong>${esc(s.neighbor)}</strong> &nbsp;→&nbsp; <span class="muted">Guest:</span> ${c ? `<strong>${esc(c.guest_name)}</strong>${c.car_color || c.car_model ? ` · 🚙 ${esc([c.car_color, c.car_model].filter(Boolean).join(" "))}` : ""}${c.email ? " · " + esc(c.email) : ""}${c.phone ? " · " + esc(c.phone) : ""}` : `<em>not claimed yet</em>`}</div>`;
  }).join("");
  const hostRec = ev.email ? await db.getHost(ev.email).catch(() => null) : null;
  const oLink = offerLink(ev), gLink = guestLink(ev, spots);
  const waText = `Hi neighbors! 🙏 We're hosting an event on ${ev.party_date} (${ev.time_from}–${ev.time_to}) and need ${ev.needed} extra parking spots. If your driveway is free, please offer a spot here (takes 30 seconds): ${oLink}`;
  $app.innerHTML = `
  <div class="card"><span class="badge">${esc(ev.party_date)} · ${esc(ev.time_from)}–${esc(ev.time_to)}</span>
    <div class="big">${esc(ev.host_name)}'s event</div><p class="muted">${esc(ev.address)} · needs ${ev.needed} spots · <strong>${lockedSpots} locked</strong></p>
    <p style="background:#fef3c7;border:1px solid #b45309;border-radius:9px;padding:10px"><strong>🔒 This page is your PRIVATE host dashboard — do not share this page's web address.</strong> It shows neighbors' phone numbers and lets anyone lock/unlock spots. Share only the NEIGHBOR LINK in step 2 below (it looks different: it has <strong>/e/</strong> in it, this dashboard has <strong>/host/</strong>).</p>
    <div id="map"></div>
    <h3>How guests are identified</h3>
    <p class="muted">No passcodes — each guest claims with their name and car (color + make & model), so you and the neighbor can recognize exactly who is parking.</p>
    <h3>Host PIN</h3>
    ${ev.email ? (hostRec ? `<p class="muted">Your host PIN (for <strong>${esc(ev.email)}</strong>) protects ALL your events ✓ — one PIN for every dashboard.</p>
      <div class="row"><div><label>Current PIN</label><input id="hpin-cur" type="password" inputmode="numeric" maxlength="8"></div>
      <div><label>New PIN (4–8 digits)</label><input id="hpin-new" type="password" inputmode="numeric" maxlength="8"></div></div>
      <p><button class="secondary" id="hpin-change">Change PIN for all my events</button> <a href="#" id="hpin-forgot">Forgot PIN? Reset by email →</a></p><div id="hpin-forgot-box"></div>`
    : ev.host_pin_hash ? `<p class="muted">This event has a PIN, but no host PIN is saved for your email yet — so each event still asks separately.</p>
      <p><button class="secondary" id="hpin-adopt">Use this event's PIN as my host PIN for all events</button></p>
      <div class="row"><div><label>Current PIN</label><input id="hpin-cur" type="password" inputmode="numeric" maxlength="8"></div>
      <div><label>New PIN (4–8 digits)</label><input id="hpin-new" type="password" inputmode="numeric" maxlength="8"></div></div>
      <p><button class="secondary" id="hpin-change">Change PIN for all my events</button></p>`
    : `<p class="muted">⚠️ No host PIN yet — set one now; it will protect this and all your future events.</p>
      <label>Host PIN (4–8 digits)</label><input id="hpin-new" type="password" inputmode="numeric" maxlength="8" style="max-width:220px">
      <p><button class="secondary" id="hpin-set">Set host PIN</button></p>`)
    : (ev.host_pin_hash ? `<p class="muted">This dashboard is protected by a host PIN ✓ — only someone with the PIN can open it and accept offers.</p>
      <div class="row"><div><label>Current PIN</label><input id="pin-cur" type="password" inputmode="numeric" maxlength="8"></div>
      <div><label>New PIN (4–8 digits)</label><input id="pin-new" type="password" inputmode="numeric" maxlength="8"></div></div>
      <p><button class="secondary" id="pin-change">Change PIN</button></p>`
    : `<p class="muted">⚠️ This event has no host PIN yet — anyone with this dashboard link could manage it. Set one now:</p>
      <label>New host PIN (4–8 digits)</label><input id="pin-new" type="password" inputmode="numeric" maxlength="8" style="max-width:220px">
      <p><button class="secondary" id="pin-set">Set host PIN</button></p>`)}
    <p class="muted" id="pin-msg"></p>
    <h3>2 · ✅ Share THIS link with neighbors — post it in your WhatsApp group</h3>
    <p class="linkbox">${esc(oLink)}</p>
    <p><a class="btn" target="_blank" href="${waShare(waText)}">Share on WhatsApp</a>
    <button class="secondary" onclick="navigator.clipboard.writeText('${oLink}');this.textContent='Copied ✓'">Copy link</button></p>
    <h3>4 · After you lock spots, send this link to your guests</h3>
    <p class="linkbox">${lockedSpots ? esc(gLink) : "Lock at least one offer below first."}</p>
    ${lockedSpots ? `<p><a class="btn" target="_blank" href="${waShare("Your parking for " + ev.host_name + "'s event — claim your spot here: " + gLink)}">Share guest link on WhatsApp</a></p>` : ""}
  </div>
  <div class="card"><h2>3 · Offers from neighbors (${offers.length}) — closest first</h2>
    ${offers.length ? "" : `<p class="muted">No offers yet${LIVE ? "" : " on this device. When a neighbor offers, they'll send you an offer link — open it on this phone/computer and it lands here automatically"}.</p>`}
    ${offers.map((o) => `<div class="spot"><strong>${esc(o.neighbor_name)}</strong> <span class="badge ${o.status === "locked" ? "" : "grey"}">${o.status === "locked" ? "LOCKED" : "offered"}</span>
      <span class="badge amber">${distLabel(o.dist)}</span><br><span class="muted">${esc(o.address)} · ${o.spots} spot(s)${o.phone ? " · " + esc(o.phone) : ""}${o.notes ? " · " + esc(o.notes) : ""}</span><br>
      <button data-lock="${o.id}">${o.status === "locked" ? "Unlock" : "Accept & lock"}</button></div>`).join("")}
  </div>
  <div class="card"><h2>🅿️ Parking assignments — who parks where (${spots.length} spot${spots.length === 1 ? "" : "s"})</h2>
    ${spots.length ? assignRows : `<p class="muted">Lock a neighbor's offer above and the neighbor → guest mapping for each spot will appear here.</p>`}
  </div>
  <div class="card"><h2>Guest claims (${claims.length})</h2>
    ${claims.length ? claims.map((c) => `<div class="spot"><strong>${esc(c.guest_name)}</strong> — ${esc(c.address)}${c.car_color || c.car_model ? ` · 🚙 ${esc([c.car_color, c.car_model].filter(Boolean).join(" "))}` : ""}</div>`).join("") : `<p class="muted">No claims yet${LIVE ? "" : " on this device. Guests get a claim link to send back to you"}.</p>`}
  </div>`;
  drawMap("map", [{ lat: ev.lat, lng: ev.lng, label: "Event: " + ev.address }, ...offers.filter((o) => o.lat).map((o) => ({ lat: o.lat, lng: o.lng, label: o.neighbor_name + " — " + o.address }))]);
  $app.querySelectorAll("[data-lock]").forEach((b) => b.addEventListener("click", async () => {
    const o = offers.find((x) => String(x.id) === b.dataset.lock);
    o.status = o.status === "locked" ? "offered" : "locked"; if (o.status === "locked" && !o.code) o.code = passcode();
    try { await db.setOfferStatus(o.id, o.status); } catch {}
    saveOffers(ev.id, offers);
    if (LIVE) notifyLockChange(ev, o, o.status);
    hostView(ev.id);
  }));
  const pinMsg = document.getElementById("pin-msg");
  const pinSet = document.getElementById("pin-set");
  if (pinSet) pinSet.addEventListener("click", async () => {
    const v = document.getElementById("pin-new").value.trim();
    if (!/^\d{4,8}$/.test(v)) { pinMsg.textContent = "PIN must be 4–8 digits."; return; }
    try { await db.setEventPin(ev, await sha256Hex(v)); sessionStorage.setItem("parknear_host_" + ev.id, "1"); } catch (e) { pinMsg.textContent = e.message; return; }
    hostView(ev.id);
  });
  const pinChange = document.getElementById("pin-change");
  if (pinChange) pinChange.addEventListener("click", async () => {
    const cur = document.getElementById("pin-cur").value.trim();
    const v = document.getElementById("pin-new").value.trim();
    if ((await sha256Hex(cur)) !== ev.host_pin_hash) { pinMsg.textContent = "Current PIN doesn't match."; return; }
    if (!/^\d{4,8}$/.test(v)) { pinMsg.textContent = "New PIN must be 4–8 digits."; return; }
    try { await db.setEventPin(ev, await sha256Hex(v)); } catch (e) { pinMsg.textContent = e.message; return; }
    hostView(ev.id);
  });
  // Host-level PIN controls (event has an email): one PIN for all events.
  const hpinSet = document.getElementById("hpin-set");
  if (hpinSet) hpinSet.addEventListener("click", async () => {
    const v = document.getElementById("hpin-new").value.trim();
    if (!/^\d{4,8}$/.test(v)) { pinMsg.textContent = "PIN must be 4–8 digits."; return; }
    try { await db.setHostPinEverywhere(ev.email, await sha256Hex(v)); } catch (e) { pinMsg.textContent = e.message; return; }
    hostView(ev.id);
  });
  const hpinChange = document.getElementById("hpin-change");
  if (hpinChange) hpinChange.addEventListener("click", async () => {
    const cur = document.getElementById("hpin-cur").value.trim();
    const v = document.getElementById("hpin-new").value.trim();
    const hostNow = await db.getHost(ev.email).catch(() => null);
    const curHash = (hostNow && hostNow.pin_hash) || ev.host_pin_hash;
    if ((await sha256Hex(cur)) !== curHash) { pinMsg.textContent = "Current PIN doesn't match."; return; }
    if (!/^\d{4,8}$/.test(v)) { pinMsg.textContent = "New PIN must be 4–8 digits."; return; }
    try { await db.setHostPinEverywhere(ev.email, await sha256Hex(v)); } catch (e) { pinMsg.textContent = e.message; return; }
    hostView(ev.id);
  });
  const hpinAdopt = document.getElementById("hpin-adopt");
  if (hpinAdopt) hpinAdopt.addEventListener("click", async () => {
    try { await db.saveHostPin(ev.email, ev.host_pin_hash); } catch (e) { pinMsg.textContent = e.message; return; }
    hostView(ev.id);
  });
  const hpinForgot = document.getElementById("hpin-forgot");
  if (hpinForgot) hpinForgot.addEventListener("click", (e) => { e.preventDefault(); renderPinReset(document.getElementById("hpin-forgot-box"), ev.email, null); });
}

async function offerView(ref) {
  const ev = await resolveEvent(ref);
  if (!ev) { $app.innerHTML = `<div class="card"><p>This event link isn't valid anymore. Ask the host for a fresh link.</p></div>`; return; }
  $app.innerHTML = `
  <div class="card"><span class="badge">${esc(ev.party_date)} · ${esc(ev.time_from)}–${esc(ev.time_to)}</span>
    <div class="big">Can you offer a driveway spot?</div>
    <p><strong>${esc(ev.host_name)}</strong> at ${esc(ev.address)} is hosting an event and needs ${ev.needed} spots.${ev.notes ? " Note: " + esc(ev.notes) : ""}</p>
    <div id="map"></div></div>
  <div class="card"><h2>Offer your spot</h2><form id="of-form">
    <label>Your name</label><input id="o-name" required placeholder="Your name">
    <label>Your email (required — your offer details and your guest's details are sent here)</label><input id="o-email" type="email" required placeholder="you@example.com">
    <label>Your home address</label><input id="o-addr" required placeholder="Street, City, State ZIP">
    <div class="row"><div><label>Spots you can offer</label><input id="o-spots" type="number" min="1" max="6" value="1" required></div>
    <div><label>Mobile (optional, only the host sees it)</label><input id="o-phone" type="tel"></div></div>
    <label>Notes (optional)</label><textarea id="o-notes" rows="2" placeholder="e.g. Left side of driveway, please don't block the garage"></textarea>
    <p><button type="submit">Offer my spot →</button></p><p class="muted" id="of-msg"></p></form>
    <div id="of-done"></div></div>`;
  attachAutocomplete(document.getElementById("o-addr"));
  drawMap("map", [{ lat: ev.lat, lng: ev.lng, label: "Event: " + ev.address }]);
  document.getElementById("of-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("of-msg"); msg.textContent = "Finding your address on the map…";
    const addr = document.getElementById("o-addr").value.trim();
    let geo = null; try { geo = await geocode(addr); } catch {}
    if (!geo) { msg.textContent = "Could not pin that address — check spelling and ZIP, then try again."; return; }
    const offer = { id: uid(), event_id: ev.id, neighbor_name: document.getElementById("o-name").value.trim(), address: addr,
      email: document.getElementById("o-email").value.trim(),
      lat: geo.lat, lng: geo.lng, spots: +document.getElementById("o-spots").value, phone: document.getElementById("o-phone").value.trim(),
      notes: document.getElementById("o-notes").value.trim(), status: "offered", code: passcode() };
    const d = haversineMi(ev.lat, ev.lng, geo.lat, geo.lng);
    const myLink = `${base()}#/o/${offer.id}`;
    const detailsText = `Your ParkNextDoor offer for ${ev.host_name}'s event on ${ev.party_date} (${ev.time_from}–${ev.time_to}) at ${ev.address}.\nYour spot: ${addr} (${offer.spots} spot(s), ${distLabel(d)} from the event)\nYour guest will identify themselves by name and car (color + make & model) — no passcode needed.\nSee who claimed your spot: ${myLink}`;
    emailDetails(offer.email, offer.neighbor_name, `Your ParkNextDoor parking offer — ${ev.party_date}`, detailsText);
    if (LIVE) {
      try { await db.addOffer(offer); } catch (err) { msg.textContent = err.message; return; }
      if (ev.email) emailDetails(ev.email, ev.host_name, `New parking offer for your event — ${ev.party_date}`,
        `${offer.neighbor_name} just offered ${offer.spots} parking spot(s) at ${offer.address} (${distLabel(d)} from your event at ${ev.address}) for your event on ${ev.party_date}, ${ev.time_from}–${ev.time_to}.\nOpen your host dashboard to review it and lock the spots you want: ${base()}#/host/${ev.id}`);
      document.getElementById("of-done").innerHTML = `<div class="card"><div class="big">Thank you! 🎉</div><p>Your ${offer.spots} spot(s) — ${distLabel(d)} from the event — are offered. ${esc(ev.host_name)} will lock the closest spots.</p>
        <p>Your guest will identify themselves <strong>by name and car</strong> (color + make & model) — no passcode to remember.</p>
        <p><strong>Your personal offer page</strong> — bookmark it to see which guest claimed your spot (their name and car):</p><p class="linkbox">${myLink}</p>
        <p>${mailtoBtn(offer.email, "Your ParkNextDoor parking offer — " + ev.party_date, detailsText)}</p></div>`;
    } else {
      const importLink = `${base()}#/import/${enc({ ev, offer })}`;
      const text = `Hi ${ev.host_name}, I can offer ${offer.spots} parking spot(s) at ${addr} (${distLabel(d)}) for your ${ev.party_date} event. Tap this link to add my offer to your dashboard: ${importLink}`;
      document.getElementById("of-done").innerHTML = `<div class="card"><div class="big">Thank you! 🎉 One last tap:</div>
        <p>Send your offer to ${esc(ev.host_name)} so it lands in his dashboard:</p>
        <p><a class="btn" target="_blank" href="${ev.phone ? "https://wa.me/" + ev.phone.replace(/\D/g, "") + "?text=" + encodeURIComponent(text) : waShare(text)}">Send offer on WhatsApp</a>
        <button class="secondary" onclick="navigator.clipboard.writeText('${importLink}');this.textContent='Copied ✓'">Copy offer link</button></p>
        <p>Your guest will identify themselves <strong>by name and car</strong> (color + make & model).</p></div>`;
    }
    msg.textContent = "";
  });
}

function importView(ref) {
  let data = null; try { data = dec(ref); } catch {}
  if (!data || !data.offer) { $app.innerHTML = `<div class="card"><p>This offer link isn't valid.</p></div>`; return; }
  const { ev, offer } = data; saveEvent(ev);
  const offers = offersFor(ev.id); if (!offers.some((o) => o.id === offer.id)) { offers.push(offer); saveOffers(ev.id, offers); }
  $app.innerHTML = `<div class="card"><div class="big">Offer added ✓</div><p><strong>${esc(offer.neighbor_name)}</strong> offered ${offer.spots} spot(s) at ${esc(offer.address)}.</p><p><a class="btn" href="#/host/${ev.id}">Open host dashboard</a></p></div>`;
}

async function guestView(ref) {
  let ev, spots = [];
  if (LIVE) {
    ev = await db.getEvent(ref);
    if (ev) { const offers = (await db.listOffers(ev.id)).filter((o) => o.status === "locked");
      spots = offers.flatMap((o) => Array.from({ length: o.spots || 1 }, (_, i) => ({ offer_id: o.id, neighbor: o.neighbor_name, nemail: o.email, address: o.address, lat: o.lat, lng: o.lng, label: o.spots > 1 ? `Spot ${i + 1} of ${o.spots}` : "Driveway spot", code: o.code })));
      const claims = await db.listClaims(ev.id);
      spots.forEach((s) => { const taken = claims.find((c) => c.address === s.address && c.spot_label === s.label); if (taken) s.takenBy = taken.guest_name; });
    }
  } else {
    try { const data = dec(ref); ev = data.ev; spots = data.spots || []; } catch {}
    const claimed = store.get("parknear_taken_" + (ev ? ev.id : ""), []);
    spots.forEach((s, i) => { if (claimed.includes(i)) s.takenLocally = true; });
  }
  if (!ev) { $app.innerHTML = `<div class="card"><p>This guest link isn't valid anymore. Ask the host for a fresh link.</p></div>`; return; }
  const neighborLabel = (s) => esc(s.neighbor);
  spots = spots.map((s) => ({ ...s, dist: haversineMi(ev.lat, ev.lng, s.lat, s.lng) })).sort((a, b) => (a.dist ?? 99) - (b.dist ?? 99));
  $app.innerHTML = `
  <div class="card"><span class="badge">${esc(ev.party_date)} · ${esc(ev.time_from)}–${esc(ev.time_to)}</span>
    <div class="big">Parking for ${esc(ev.host_name)}'s event</div><p class="muted">Event at ${esc(ev.address)}. Claim a spot below — the neighbor will recognize you by your name and your car (color + make & model). No passcode needed.</p><div id="map"></div></div>
  <div class="card"><h2>Available spots — closest first</h2>
    ${spots.length ? "" : `<p class="muted">No spots have been locked for guests yet. Check back soon.</p>`}
    <div id="spot-list">${spots.map((s, i) => `<div class="spot"><strong>${esc(s.address)}</strong> <span class="badge amber">${distLabel(s.dist)}</span>
      <br><span class="muted">${esc(s.label)} · offered by ${neighborLabel(s)}${s.takenBy ? " · this spot is claimed" : ""}</span>
      <div data-claim-zone="${i}">${s.takenBy || s.takenLocally ? `<p class="muted">This spot is claimed.</p>` : `<br><input placeholder="Your name" id="g-name-${i}"><input placeholder="Your email (required)" type="email" id="g-email-${i}"><input placeholder="Mobile (optional)" type="tel" id="g-phone-${i}"><br><input placeholder="Car color (required) — e.g. Silver" id="g-carcolor-${i}"><input placeholder="Car make & model (required) — e.g. Toyota Camry" id="g-carmodel-${i}"> <button data-claim="${i}">Claim this spot</button>`}</div></div>`).join("")}</div>
    <div id="claim-done"></div></div>`;
  drawMap("map", [{ lat: ev.lat, lng: ev.lng, label: "Event: " + ev.address }, ...spots.filter((s) => s.lat).map((s) => ({ lat: s.lat, lng: s.lng, label: s.address }))]);
  $app.querySelectorAll("[data-claim]").forEach((b) => b.addEventListener("click", async () => {
    const i = +b.dataset.claim, s = spots[i];
    const name = document.getElementById("g-name-" + i).value.trim();
    if (!name) { alert("Please enter your name first."); return; }
    const gEmail = document.getElementById("g-email-" + i).value.trim();
    if (!gEmail || !gEmail.includes("@")) { alert("Please enter your email — your parking details are sent there for reference."); return; }
    const gPhone = document.getElementById("g-phone-" + i).value.trim();
    const carColor = document.getElementById("g-carcolor-" + i).value.trim();
    if (!carColor) { alert("Please enter your car color — the neighbor will recognize your car by it."); return; }
    const carModel = document.getElementById("g-carmodel-" + i).value.trim();
    if (!carModel) { alert("Please enter your car make & model — e.g. Toyota Camry."); return; }
    const claim = { id: uid(), event_id: ev.id, guest_name: name, email: gEmail, phone: gPhone, car_color: carColor, car_model: carModel, address: s.address, spot_label: s.label, code: s.code };
    let notifyHtml = "";
    if (LIVE) { try { await db.addClaim(claim); } catch (e) { alert(e.message); return; }
      if (ev.email) emailDetails(ev.email, ev.host_name, `A guest claimed a parking spot — ${ev.party_date}`,
        `${name} just claimed the spot at ${s.address} (${s.label}, offered by ${s.neighbor}) for your event on ${ev.party_date}, ${ev.time_from}–${ev.time_to}.\nGuest: ${name} · ${gEmail}${gPhone ? " · " + gPhone : ""}\nCar: ${carColor} ${carModel}\nSee all parking assignments: ${base()}#/host/${ev.id}`);
      if (s.nemail) emailDetails(s.nemail, s.neighbor, `Your parking spot was claimed — ${ev.party_date}`,
        `${name} claimed your spot at ${s.address} for ${ev.host_name}'s event on ${ev.party_date} (${ev.time_from}–${ev.time_to}).\nGuest to expect: ${name} — car: ${carColor} ${carModel}\nYour offer page: ${base()}#/o/${s.offer_id}`);
    }
    else {
      const taken = store.get("parknear_taken_" + ev.id, []); taken.push(spots.indexOf(s)); store.set("parknear_taken_" + ev.id, taken);
      const claimLink = `${base()}#/claim/${enc({ ev, claim })}`;
      notifyHtml = `<p><a class="btn" target="_blank" href="${waShare(`Hi ${ev.host_name}, I'm ${name} — I claimed the spot at ${s.address} for your event. My car: ${carColor} ${carModel}.`)}">Tell the host on WhatsApp</a></p>`;
    }
    const gDetails = `Your parking for ${ev.host_name}'s event on ${ev.party_date} (${ev.time_from}–${ev.time_to}).\nDrive to: ${s.address} (${s.label}, ${distLabel(s.dist)} from the event at ${ev.address})\nNeighbor: ${s.neighbor}\nYour car on record: ${carColor} ${carModel} — ${s.neighbor} will recognize you by your name and car.`;
    emailDetails(gEmail, name, `Your parking for ${ev.host_name}'s event — ${ev.party_date}`, gDetails);
    document.getElementById("claim-done").innerHTML = `<div class="card"><div class="big">You're parked! 🎉</div>
      <p>Drive to: <strong>${esc(s.address)}</strong> (${distLabel(s.dist)} from the event)</p>
      <p><a class="btn" target="_blank" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(s.address)}">Navigate with Google Maps</a></p>
      <p>The neighbor is <strong>${esc(s.neighbor)}</strong> — they'll recognize you by your name and your car: <strong>${esc(carColor)} ${esc(carModel)}</strong>. No passcode needed.</p>
      <p>${mailtoBtn(gEmail, "Your parking for " + ev.host_name + "'s event — " + ev.party_date, gDetails)}</p>${notifyHtml}</div>`;
    document.getElementById("claim-done").scrollIntoView({ behavior: "smooth" });
  }));
}

async function neighborView(offerId) {
  if (!LIVE) { $app.innerHTML = `<div class="card"><p>Your offer page is available in Live Mode.</p></div>`; return; }
  const offer = await db.getOffer(offerId);
  if (!offer) { $app.innerHTML = `<div class="card"><p>This offer link isn't valid anymore.</p></div>`; return; }
  const ev = await db.getEvent(offer.event_id);
  const claims = (await db.listClaims(offer.event_id)).filter((c) => c.address === offer.address);
  $app.innerHTML = `
  <div class="card"><span class="badge">${ev ? esc(ev.party_date) + " · " + esc(ev.time_from) + "–" + esc(ev.time_to) : ""}</span>
    <div class="big">Your parking offer${ev ? ` for ${esc(ev.host_name)}'s event` : ""}</div>
    <p><strong>${esc(offer.neighbor_name)}</strong> · ${esc(offer.address)} · ${offer.spots} spot(s) · status: <strong>${esc(offer.status)}</strong></p>
    <p>Guests identify themselves <strong>by name and car</strong> (color + make & model) — no passcode needed.</p>
  </div>
  <div class="card"><h2>Who claimed your spot${offer.spots > 1 ? "s" : ""} (${claims.length})</h2>
    ${claims.length ? claims.map((c) => `<div class="spot"><strong>${esc(c.spot_label)}</strong> → Guest: <strong>${esc(c.guest_name)}</strong>${c.car_color || c.car_model ? ` · 🚙 ${esc([c.car_color, c.car_model].filter(Boolean).join(" "))}` : ""}</div>`).join("") : `<p class="muted">No guest has claimed your spot yet. This page updates as guests claim — bookmark it and check on event day.</p>`}
    <p class="muted">Event at ${ev ? esc(ev.address) : ""}. Keep this page's link private — it shows your claim details.</p></div>`;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const adminState = { tab: "events", eventId: null, offerFilter: "all" };
const todayStr = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const evStatus = (ev) => ev.party_date === todayStr() ? "today" : (ev.party_date > todayStr() ? "upcoming" : "past");
const statusChip = (st) => st === "today" ? `<span class="badge">TODAY</span>` : st === "upcoming" ? `<span class="badge amber">UPCOMING</span>` : `<span class="badge" style="background:#e2e8f0;color:#475569">PAST</span>`;

async function adminView() {
  const pinHash = (CFG.adminPinHash || "").trim();
  if (!LIVE) { $app.innerHTML = `<div class="card"><p>The admin page needs Live Mode.</p></div>`; return; }
  if (!pinHash) { $app.innerHTML = `<div class="card"><div class="big">🔐 Admin</div><p>The admin PIN hasn't been set yet. Ask the app owner to set one, then reload this page.</p></div>`; return; }
  if (sessionStorage.getItem("parknear_admin") !== "1") {
    $app.innerHTML = `<div class="card"><div class="big">🔐 Admin sign-in</div>
      <p class="muted">Enter the admin PIN to see and manage all events, offers, and claims.</p>
      <input id="admin-pin" type="password" inputmode="numeric" placeholder="Admin PIN" style="max-width:220px">
      <p><button id="admin-go">Unlock admin →</button></p><p class="muted" id="admin-msg"></p></div>`;
    document.getElementById("admin-go").addEventListener("click", async () => {
      const v = document.getElementById("admin-pin").value.trim();
      if ((await sha256Hex(v)) === pinHash) { sessionStorage.setItem("parknear_admin", "1"); adminView(); }
      else document.getElementById("admin-msg").textContent = "Wrong PIN — try again.";
    });
    return;
  }
  const events = await db.listAllEvents();
  const data = new Map();
  let totOffers = 0, totClaims = 0, totLocked = 0;
  for (const ev of events) {
    const offers = await db.listOffers(ev.id);
    const claims = await db.listClaims(ev.id);
    data.set(ev.id, { offers, claims });
    totOffers += offers.length; totClaims += claims.length; totLocked += offers.filter((o) => o.status === "locked").length;
  }
  const counts = { today: 0, upcoming: 0, past: 0 };
  events.forEach((ev) => counts[evStatus(ev)]++);
  const head = `<div class="card"><div class="big">🛠️ ParkNextDoor Admin</div>
    <div class="statrow">
      <div class="stat"><div class="statnum">${events.length}</div><div class="statlbl">Events</div></div>
      <div class="stat"><div class="statnum">${counts.today + counts.upcoming}</div><div class="statlbl">Today + upcoming</div></div>
      <div class="stat"><div class="statnum">${totOffers}</div><div class="statlbl">Offers (${totLocked} locked)</div></div>
      <div class="stat"><div class="statnum">${totClaims}</div><div class="statlbl">Guest claims</div></div>
    </div>
    <p><button class="secondary" id="admin-refresh">↻ Refresh</button> <button class="secondary" id="admin-lock">Lock admin</button></p></div>`;
  const tabs = `<div class="card tabbar">
      <button data-tab="events" class="${adminState.tab === "events" && !adminState.eventId ? "" : "secondary"}">🎉 Events</button>
      <button data-tab="offers" class="${adminState.tab === "offers" ? "" : "secondary"}">🙋 Offers</button>
      <button data-tab="claims" class="${adminState.tab === "claims" ? "" : "secondary"}">🎟️ Claims</button>
    </div>`;
  let body = "";
  if (adminState.eventId) {
    const ev = events.find((e) => e.id === adminState.eventId);
    if (!ev) { adminState.eventId = null; return adminView(); }
    const { offers, claims } = data.get(ev.id);
    body = `<div class="card"><p><button class="secondary" id="admin-back">← All events</button></p>
      <span class="badge">${esc(ev.party_date || "")} · ${esc(ev.time_from || "")}–${esc(ev.time_to || "")}</span> ${statusChip(evStatus(ev))}
      <div class="big">${esc(ev.host_name)}'s event</div>
      <p class="muted">${esc(ev.address)} · needs ${ev.needed} spots${ev.email ? " · host email " + esc(ev.email) : ""}${ev.phone ? " · " + esc(ev.phone) : ""}</p>
      <p><a class="btn secondary" href="#/host/${ev.id}">Open host dashboard</a> <button class="danger" data-del-event="${ev.id}">Delete event</button></p>
      <h3>🙋 Offers (${offers.length})</h3>
      ${offers.length ? offers.map((o) => `<div class="spot"><strong>${esc(o.neighbor_name)}</strong> — ${esc(o.status)} — ${esc(o.address)} · ${o.spots} spot(s)${o.email ? " · " + esc(o.email) : ""}${o.phone ? " · " + esc(o.phone) : ""}
        <br><button class="secondary" data-toggle-offer="${o.id}" data-ev="${ev.id}">${o.status === "locked" ? "Unlock" : "Accept & lock"}</button> <button class="danger" data-del-offer="${o.id}">Delete offer</button></div>`).join("") : `<p class="muted">No offers yet.</p>`}
      <h3>🎟️ Guest claims (${claims.length})</h3>
      ${claims.length ? claims.map((c) => `<div class="spot"><strong>${esc(c.guest_name)}</strong> → ${esc(c.address)} · ${esc(c.spot_label || "")}${c.email ? " · " + esc(c.email) : ""}${c.phone ? " · " + esc(c.phone) : ""}${c.car_color || c.car_model ? " · 🚙 " + esc([c.car_color, c.car_model].filter(Boolean).join(" ")) : ""}
        <br><button class="danger" data-del-claim="${c.id}">Delete claim</button></div>`).join("") : `<p class="muted">No claims yet.</p>`}
    </div>`;
  } else if (adminState.tab === "offers") {
    const f = adminState.offerFilter;
    let rows = [];
    events.forEach((ev) => data.get(ev.id).offers.forEach((o) => rows.push({ ev, o })));
    if (f !== "all") rows = rows.filter(({ o }) => o.status === f);
    body = `<div class="card"><h2>🙋 All offers (${rows.length})</h2>
      <p><button data-ofilter="all" class="${f === "all" ? "" : "secondary"}">All</button> <button data-ofilter="offered" class="${f === "offered" ? "" : "secondary"}">Offered</button> <button data-ofilter="locked" class="${f === "locked" ? "" : "secondary"}">Locked</button></p>
      ${rows.length ? rows.map(({ ev, o }) => `<div class="spot"><strong>${esc(o.neighbor_name)}</strong> — ${esc(o.status)} — ${esc(o.address)} · ${o.spots} spot(s)${o.email ? " · " + esc(o.email) : ""}
        <br><span class="muted">Event: ${esc(ev.host_name)} · ${esc(ev.party_date)}</span> <button class="secondary" data-open-event="${ev.id}">Open event</button> <button class="secondary" data-toggle-offer="${o.id}" data-ev="${ev.id}">${o.status === "locked" ? "Unlock" : "Accept & lock"}</button> <button class="danger" data-del-offer="${o.id}">Delete</button></div>`).join("") : `<p class="muted">No offers in this category.</p>`}</div>`;
  } else if (adminState.tab === "claims") {
    let rows = [];
    events.forEach((ev) => data.get(ev.id).claims.forEach((c) => rows.push({ ev, c })));
    body = `<div class="card"><h2>🎟️ All guest claims (${rows.length})</h2>
      ${rows.length ? rows.map(({ ev, c }) => `<div class="spot"><strong>${esc(c.guest_name)}</strong> → ${esc(c.address)} · ${esc(c.spot_label || "")}${c.car_color || c.car_model ? " · 🚙 " + esc([c.car_color, c.car_model].filter(Boolean).join(" ")) : ""}${c.email ? " · " + esc(c.email) : ""}${c.phone ? " · " + esc(c.phone) : ""}
        <br><span class="muted">Event: ${esc(ev.host_name)} · ${esc(ev.party_date)}</span> <button class="secondary" data-open-event="${ev.id}">Open event</button> <button class="danger" data-del-claim="${c.id}">Delete claim</button></div>`).join("") : `<p class="muted">No claims yet.</p>`}</div>`;
  } else {
    const groups = [["today", "📅 Today"], ["upcoming", "🔜 Upcoming"], ["past", "🗂️ Past"]];
    body = groups.map(([key, label]) => {
      const list = events.filter((ev) => evStatus(ev) === key)
        .sort((a, b) => key === "past" ? b.party_date.localeCompare(a.party_date) : a.party_date.localeCompare(b.party_date));
      if (!list.length) return "";
      return `<div class="card"><h2>${label} (${list.length})</h2>` + list.map((ev) => {
        const { offers, claims } = data.get(ev.id);
        const lockedN = offers.filter((o) => o.status === "locked").length;
        return `<div class="spot"><strong>${esc(ev.host_name)}</strong> · ${esc(ev.party_date)} · ${esc(ev.time_from || "")}–${esc(ev.time_to || "")} ${statusChip(key)}
          <br><span class="muted">${esc(ev.address)}</span>
          <br><span class="muted">Needs ${ev.needed} · 🙋 ${offers.length} offers (${lockedN} locked) · 🎟️ ${claims.length} claims</span>
          <br><button class="secondary" data-open-event="${ev.id}">View & manage →</button> <a class="btn secondary" href="#/host/${ev.id}">Host dashboard</a></div>`;
      }).join("") + `</div>`;
    }).join("") || `<div class="card"><p>No events yet.</p></div>`;
  }
  $app.innerHTML = head + tabs + body;
  document.getElementById("admin-refresh").addEventListener("click", adminView);
  document.getElementById("admin-lock").addEventListener("click", () => { sessionStorage.removeItem("parknear_admin"); adminState.eventId = null; adminView(); });
  $app.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { adminState.tab = b.dataset.tab; adminState.eventId = null; adminView(); }));
  $app.querySelectorAll("[data-ofilter]").forEach((b) => b.addEventListener("click", () => { adminState.offerFilter = b.dataset.ofilter; adminView(); }));
  $app.querySelectorAll("[data-open-event]").forEach((b) => b.addEventListener("click", () => { adminState.eventId = b.dataset.openEvent; adminView(); }));
  const back = document.getElementById("admin-back");
  if (back) back.addEventListener("click", () => { adminState.eventId = null; adminView(); });
  $app.querySelectorAll("[data-del-event]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this whole event, including its offers and claims? This cannot be undone.")) return;
    try { await db.deleteEvent(b.dataset.delEvent); } catch (e) { alert(e.message); return; }
    adminState.eventId = null; adminView();
  }));
  $app.querySelectorAll("[data-del-offer]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this offer?")) return;
    try { await db.deleteOffer(b.dataset.delOffer); } catch (e) { alert(e.message); return; } adminView();
  }));
  $app.querySelectorAll("[data-del-claim]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this guest claim? The spot becomes available again.")) return;
    try { await db.deleteClaim(b.dataset.delClaim); } catch (e) { alert(e.message); return; } adminView();
  }));
  $app.querySelectorAll("[data-toggle-offer]").forEach((b) => b.addEventListener("click", async () => {
    const offers = await db.listOffers(b.dataset.ev);
    const o = offers.find((x) => String(x.id) === b.dataset.toggleOffer);
    if (!o) return;
    const newStatus = o.status === "locked" ? "offered" : "locked";
    try { await db.setOfferStatus(o.id, newStatus); } catch (e) { alert(e.message); return; }
    const evA = await db.getEvent(b.dataset.ev);
    if (evA) notifyLockChange(evA, o, newStatus);
    adminView();
  }));
}

function claimImportView(ref) {
  let data = null; try { data = dec(ref); } catch {}
  if (!data || !data.claim) { $app.innerHTML = `<div class="card"><p>This claim link isn't valid.</p></div>`; return; }
  const { ev, claim } = data; saveEvent(ev);
  const claims = claimsFor(ev.id); if (!claims.some((c) => c.id === claim.id)) { claims.push(claim); saveClaims(ev.id, claims); }
  $app.innerHTML = `<div class="card"><div class="big">Guest claim saved ✓</div><p><strong>${esc(claim.guest_name)}</strong> claimed ${esc(claim.address)}${claim.car_color ? " · 🚙 " + esc([claim.car_color, claim.car_model].filter(Boolean).join(" ")) : ""}</p><p><a class="btn" href="#/host/${ev.id}">Open host dashboard</a></p></div>`;
}

// ---------- router ----------
async function route() {
  const hash = location.hash || "#/";
  const parts = hash.replace(/^#\//, "").split("/");
  window.scrollTo(0, 0);
  try {
    if (parts[0] === "" || parts[0] === undefined) homeView();
    else if (parts[0] === "host") { if (parts[1]) await hostView(parts[1]); else await hostHomeView(); }
    else if (parts[0] === "e") await offerView(parts.slice(1).join("/"));
    else if (parts[0] === "g") await guestView(parts.slice(1).join("/"));
    else if (parts[0] === "o") await neighborView(parts[1]);
    else if (parts[0] === "admin") await adminView();
    else if (parts[0] === "import") importView(parts.slice(1).join("/"));
    else if (parts[0] === "claim") claimImportView(parts.slice(1).join("/"));
    else homeView();
  } catch (err) { $app.innerHTML = `<div class="card"><p>Something went wrong: ${esc(err.message)}</p></div>`; }
}
window.addEventListener("hashchange", route);
route();
