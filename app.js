"use strict";
/* ParkNear — neighborhood party parking.
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
async function geocode(address) {
  const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(address), { headers: { Accept: "application/json" } });
  const j = await r.json();
  return j.length ? { lat: +j[0].lat, lng: +j[0].lon } : null;
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
  async listClaims(eventId) { if (!LIVE) return claimsFor(eventId); return sb("claims?event_id=eq." + encodeURIComponent(eventId) + "&select=*&order=created_at.asc"); }
};

// ---------- map ----------
let mapObj = null;
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
  $app.innerHTML = `
  <div class="card"><div class="big">Having a party? Borrow driveway spots from your neighbors.</div>
  <p class="muted">Create a party, post one link in your WhatsApp group, neighbors offer spots, you lock the closest ones, guests claim them with a passcode. No app to install, no account to create.</p></div>
  <div class="card"><h2>1 · Host — create your party</h2>
  <form id="ev-form">
    <label>Your name</label><input id="f-host" required placeholder="e.g. Karmendra Pandey">
    <label>Your home address (party location)</label><input id="f-addr" required placeholder="Street, City, State ZIP">
    <div class="row">
      <div><label>Date</label><input id="f-date" type="date" required></div>
      <div><label>Parking spots needed</label><input id="f-needed" type="number" min="1" max="100" value="10" required></div>
    </div>
    <div class="row">
      <div><label>Guests arrive from</label><input id="f-from" type="time" value="17:00"></div>
      <div><label>Until</label><input id="f-to" type="time" value="23:00"></div>
    </div>
    <label>Your mobile (optional — neighbors/guests only see it if you share it)</label><input id="f-phone" type="tel" placeholder="Optional">
    <label>Note for neighbors (optional)</label><textarea id="f-notes" rows="2" placeholder="e.g. Diwali party, thank you! Please keep the garage side clear."></textarea>
    <p><button type="submit">Create party &amp; get my neighbor link →</button></p>
    <p class="muted" id="ev-msg"></p>
  </form></div>`;
  document.getElementById("ev-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("ev-msg"); msg.textContent = "Finding your address on the map…";
    const addr = document.getElementById("f-addr").value.trim();
    let geo = null; try { geo = await geocode(addr); } catch {}
    if (!geo) { msg.textContent = "Could not pin that address. Check the spelling (add city, state and ZIP) and try again."; return; }
    const ev = { id: uid(), host_name: document.getElementById("f-host").value.trim(), address: addr, lat: geo.lat, lng: geo.lng,
      party_date: document.getElementById("f-date").value, needed: +document.getElementById("f-needed").value,
      time_from: document.getElementById("f-from").value, time_to: document.getElementById("f-to").value,
      phone: document.getElementById("f-phone").value.trim(), notes: document.getElementById("f-notes").value.trim() };
    try { await db.createEvent(ev); } catch (err) { msg.textContent = err.message; return; }
    saveEvent(ev);
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

async function hostView(ref) {
  const events = myEvents();
  if (!events.length) { $app.innerHTML = `<div class="card"><h2>Host dashboard</h2><p>No party on this device yet.</p><p><a class="btn" href="#/">Create a party</a></p></div>`; return; }
  const ev = ref ? events.find((e) => e.id === ref) || await resolveEvent(ref) : events[events.length - 1];
  if (!ev) { $app.innerHTML = `<div class="card"><p>Party not found on this device.</p></div>`; return; }
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
  const oLink = offerLink(ev), gLink = guestLink(ev, spots);
  const waText = `Hi neighbors! 🙏 We're hosting a party on ${ev.party_date} (${ev.time_from}–${ev.time_to}) and need ${ev.needed} extra parking spots. If your driveway is free, please offer a spot here (takes 30 seconds): ${oLink}`;
  $app.innerHTML = `
  <div class="card"><span class="badge">${esc(ev.party_date)} · ${esc(ev.time_from)}–${esc(ev.time_to)}</span>
    <div class="big">${esc(ev.host_name)}'s party</div><p class="muted">${esc(ev.address)} · needs ${ev.needed} spots · <strong>${lockedSpots} locked</strong></p>
    <div id="map"></div>
    <h3>2 · Post this link in your WhatsApp group — neighbors offer spots</h3>
    <p class="linkbox">${esc(oLink)}</p>
    <p><a class="btn" target="_blank" href="${waShare(waText)}">Share on WhatsApp</a>
    <button class="secondary" onclick="navigator.clipboard.writeText('${oLink}');this.textContent='Copied ✓'">Copy link</button></p>
    <h3>4 · After you lock spots, send this link to your guests</h3>
    <p class="linkbox">${lockedSpots ? esc(gLink) : "Lock at least one offer below first."}</p>
    ${lockedSpots ? `<p><a class="btn" target="_blank" href="${waShare("Your parking for " + ev.host_name + "'s party — claim your spot here: " + gLink)}">Share guest link on WhatsApp</a></p>` : ""}
  </div>
  <div class="card"><h2>3 · Offers from neighbors (${offers.length}) — closest first</h2>
    ${offers.length ? "" : `<p class="muted">No offers yet${LIVE ? "" : " on this device. When a neighbor offers, they'll send you an offer link — open it on this phone/computer and it lands here automatically"}.</p>`}
    ${offers.map((o) => `<div class="spot"><strong>${esc(o.neighbor_name)}</strong> <span class="badge ${o.status === "locked" ? "" : "grey"}">${o.status === "locked" ? "LOCKED" : "offered"}</span>
      <span class="badge amber">${distLabel(o.dist)}</span><br><span class="muted">${esc(o.address)} · ${o.spots} spot(s)${o.phone ? " · " + esc(o.phone) : ""}${o.notes ? " · " + esc(o.notes) : ""}</span><br>
      <button data-lock="${o.id}">${o.status === "locked" ? "Unlock" : "Accept & lock"}</button></div>`).join("")}
  </div>
  <div class="card"><h2>Guest claims (${claims.length})</h2>
    ${claims.length ? claims.map((c) => `<div class="spot"><strong>${esc(c.guest_name)}</strong> — ${esc(c.address)} · passcode <strong>${esc(c.code)}</strong></div>`).join("") : `<p class="muted">No claims yet${LIVE ? "" : " on this device. Guests get a claim link to send back to you"}.</p>`}
  </div>`;
  drawMap("map", [{ lat: ev.lat, lng: ev.lng, label: "Party: " + ev.address }, ...offers.filter((o) => o.lat).map((o) => ({ lat: o.lat, lng: o.lng, label: o.neighbor_name + " — " + o.address }))]);
  $app.querySelectorAll("[data-lock]").forEach((b) => b.addEventListener("click", async () => {
    const o = offers.find((x) => String(x.id) === b.dataset.lock);
    o.status = o.status === "locked" ? "offered" : "locked"; if (o.status === "locked" && !o.code) o.code = passcode();
    try { await db.setOfferStatus(o.id, o.status); } catch {}
    saveOffers(ev.id, offers); hostView(ev.id);
  }));
}

async function offerView(ref) {
  const ev = await resolveEvent(ref);
  if (!ev) { $app.innerHTML = `<div class="card"><p>This party link isn't valid anymore. Ask the host for a fresh link.</p></div>`; return; }
  $app.innerHTML = `
  <div class="card"><span class="badge">${esc(ev.party_date)} · ${esc(ev.time_from)}–${esc(ev.time_to)}</span>
    <div class="big">Can you offer a driveway spot?</div>
    <p><strong>${esc(ev.host_name)}</strong> at ${esc(ev.address)} is hosting a party and needs ${ev.needed} spots.${ev.notes ? " Note: " + esc(ev.notes) : ""}</p>
    <div id="map"></div></div>
  <div class="card"><h2>Offer your spot</h2><form id="of-form">
    <label>Your name</label><input id="o-name" required placeholder="Your name">
    <label>Your home address</label><input id="o-addr" required placeholder="Street, City, State ZIP">
    <div class="row"><div><label>Spots you can offer</label><input id="o-spots" type="number" min="1" max="6" value="1" required></div>
    <div><label>Mobile (optional, only the host sees it)</label><input id="o-phone" type="tel"></div></div>
    <label>Notes (optional)</label><textarea id="o-notes" rows="2" placeholder="e.g. Left side of driveway, please don't block the garage"></textarea>
    <p><button type="submit">Offer my spot →</button></p><p class="muted" id="of-msg"></p></form>
    <div id="of-done"></div></div>`;
  drawMap("map", [{ lat: ev.lat, lng: ev.lng, label: "Party: " + ev.address }]);
  document.getElementById("of-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("of-msg"); msg.textContent = "Finding your address on the map…";
    const addr = document.getElementById("o-addr").value.trim();
    let geo = null; try { geo = await geocode(addr); } catch {}
    if (!geo) { msg.textContent = "Could not pin that address — check spelling and ZIP, then try again."; return; }
    const offer = { id: uid(), event_id: ev.id, neighbor_name: document.getElementById("o-name").value.trim(), address: addr,
      lat: geo.lat, lng: geo.lng, spots: +document.getElementById("o-spots").value, phone: document.getElementById("o-phone").value.trim(),
      notes: document.getElementById("o-notes").value.trim(), status: "offered", code: passcode() };
    const d = haversineMi(ev.lat, ev.lng, geo.lat, geo.lng);
    if (LIVE) {
      try { await db.addOffer(offer); } catch (err) { msg.textContent = err.message; return; }
      document.getElementById("of-done").innerHTML = `<div class="card"><div class="big">Thank you! 🎉</div><p>Your ${offer.spots} spot(s) — ${distLabel(d)} from the party — are offered. ${esc(ev.host_name)} will lock spots and your guest will get a passcode to show you: <strong>${offer.code}</strong></p></div>`;
    } else {
      const importLink = `${base()}#/import/${enc({ ev, offer })}`;
      const text = `Hi ${ev.host_name}, I can offer ${offer.spots} parking spot(s) at ${addr} (${distLabel(d)}) for your ${ev.party_date} party. Tap this link to add my offer to your dashboard: ${importLink}`;
      document.getElementById("of-done").innerHTML = `<div class="card"><div class="big">Thank you! 🎉 One last tap:</div>
        <p>Send your offer to ${esc(ev.host_name)} so it lands in his dashboard:</p>
        <p><a class="btn" target="_blank" href="${ev.phone ? "https://wa.me/" + ev.phone.replace(/\D/g, "") + "?text=" + encodeURIComponent(text) : waShare(text)}">Send offer on WhatsApp</a>
        <button class="secondary" onclick="navigator.clipboard.writeText('${importLink}');this.textContent='Copied ✓'">Copy offer link</button></p>
        <p class="muted">Your spot's passcode (your guest will show you this):</p><div class="code">${offer.code}</div></div>`;
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
      spots = offers.flatMap((o) => Array.from({ length: o.spots || 1 }, (_, i) => ({ offer_id: o.id, neighbor: o.neighbor_name, address: o.address, lat: o.lat, lng: o.lng, label: o.spots > 1 ? `Spot ${i + 1} of ${o.spots}` : "Driveway spot", code: o.code })));
      const claims = await db.listClaims(ev.id);
      spots.forEach((s) => { const taken = claims.find((c) => c.address === s.address && c.spot_label === s.label); if (taken) s.takenBy = taken.guest_name; });
    }
  } else {
    try { const data = dec(ref); ev = data.ev; spots = data.spots || []; } catch {}
    const claimed = store.get("parknear_taken_" + (ev ? ev.id : ""), []);
    spots.forEach((s, i) => { if (claimed.includes(i)) s.takenLocally = true; });
  }
  if (!ev) { $app.innerHTML = `<div class="card"><p>This guest link isn't valid anymore. Ask the host for a fresh link.</p></div>`; return; }
  spots = spots.map((s) => ({ ...s, dist: haversineMi(ev.lat, ev.lng, s.lat, s.lng) })).sort((a, b) => (a.dist ?? 99) - (b.dist ?? 99));
  $app.innerHTML = `
  <div class="card"><span class="badge">${esc(ev.party_date)} · ${esc(ev.time_from)}–${esc(ev.time_to)}</span>
    <div class="big">Parking for ${esc(ev.host_name)}'s party</div><p class="muted">Party at ${esc(ev.address)}. Claim a spot below — you'll get a passcode to show the neighbor.</p><div id="map"></div></div>
  <div class="card"><h2>Available spots — closest first</h2>
    ${spots.length ? "" : `<p class="muted">No spots have been locked for guests yet. Check back soon.</p>`}
    <div id="spot-list">${spots.map((s, i) => `<div class="spot"><strong>${esc(s.address)}</strong> <span class="badge amber">${distLabel(s.dist)}</span>
      <br><span class="muted">${esc(s.label)} · offered by ${esc(s.neighbor)}${s.takenBy ? " · claimed by " + esc(s.takenBy) : ""}</span>
      <div data-claim-zone="${i}">${s.takenBy || s.takenLocally ? `<p class="muted">This spot is claimed.</p>` : `<br><input placeholder="Your name" id="g-name-${i}"> <button data-claim="${i}">Claim this spot</button>`}</div></div>`).join("")}</div>
    <div id="claim-done"></div></div>`;
  drawMap("map", [{ lat: ev.lat, lng: ev.lng, label: "Party: " + ev.address }, ...spots.filter((s) => s.lat).map((s) => ({ lat: s.lat, lng: s.lng, label: s.address }))]);
  $app.querySelectorAll("[data-claim]").forEach((b) => b.addEventListener("click", async () => {
    const i = +b.dataset.claim, s = spots[i];
    const name = document.getElementById("g-name-" + i).value.trim();
    if (!name) { alert("Please enter your name first."); return; }
    const claim = { id: uid(), event_id: ev.id, guest_name: name, address: s.address, spot_label: s.label, code: s.code };
    let notifyHtml = "";
    if (LIVE) { try { await db.addClaim(claim); } catch (e) { alert(e.message); return; } }
    else {
      const taken = store.get("parknear_taken_" + ev.id, []); taken.push(spots.indexOf(s)); store.set("parknear_taken_" + ev.id, taken);
      const claimLink = `${base()}#/claim/${enc({ ev, claim })}`;
      notifyHtml = `<p><a class="btn" target="_blank" href="${waShare(`Hi ${ev.host_name}, I'm ${name} — I claimed the spot at ${s.address} for your party. My passcode is ${s.code}.`)}">Tell the host on WhatsApp</a></p>`;
    }
    document.getElementById("claim-done").innerHTML = `<div class="card"><div class="big">You're parked! 🎉</div>
      <p>Drive to: <strong>${esc(s.address)}</strong> (${distLabel(s.dist)} from the party)</p>
      <p><a class="btn" target="_blank" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(s.address)}">Navigate with Google Maps</a></p>
      <p class="muted">Show this passcode to ${esc(s.neighbor)} if they ask — it proves this is your spot:</p>
      <div class="code">${esc(s.code)}</div>${notifyHtml}</div>`;
    document.getElementById("claim-done").scrollIntoView({ behavior: "smooth" });
  }));
}

function claimImportView(ref) {
  let data = null; try { data = dec(ref); } catch {}
  if (!data || !data.claim) { $app.innerHTML = `<div class="card"><p>This claim link isn't valid.</p></div>`; return; }
  const { ev, claim } = data; saveEvent(ev);
  const claims = claimsFor(ev.id); if (!claims.some((c) => c.id === claim.id)) { claims.push(claim); saveClaims(ev.id, claims); }
  $app.innerHTML = `<div class="card"><div class="big">Guest claim saved ✓</div><p><strong>${esc(claim.guest_name)}</strong> claimed ${esc(claim.address)} · passcode ${esc(claim.code)}</p><p><a class="btn" href="#/host/${ev.id}">Open host dashboard</a></p></div>`;
}

// ---------- router ----------
async function route() {
  const hash = location.hash || "#/";
  const parts = hash.replace(/^#\//, "").split("/");
  window.scrollTo(0, 0);
  try {
    if (parts[0] === "" || parts[0] === undefined) homeView();
    else if (parts[0] === "host") await hostView(parts[1]);
    else if (parts[0] === "e") await offerView(parts.slice(1).join("/"));
    else if (parts[0] === "g") await guestView(parts.slice(1).join("/"));
    else if (parts[0] === "import") importView(parts.slice(1).join("/"));
    else if (parts[0] === "claim") claimImportView(parts.slice(1).join("/"));
    else homeView();
  } catch (err) { $app.innerHTML = `<div class="card"><p>Something went wrong: ${esc(err.message)}</p></div>`; }
}
window.addEventListener("hashchange", route);
route();
