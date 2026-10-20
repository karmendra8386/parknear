# ParkNear — Neighborhood Event Parking

Borrow a neighbor's driveway spot for your event. No app to install, no account for neighbors or guests.

**Flow**
1. **Host** creates an event (name, address, date, spots needed) → gets a *neighbor link*.
2. **Host** posts the link in the WhatsApp group. **Neighbors** open it, offer 1–6 driveway spots (address is pinned on a free OpenStreetMap; distance to the event is calculated automatically).
3. **Host dashboard** lists offers closest-first. Host accepts/locks spots until the event is covered → gets a *guest link* (each locked spot carries a 4-digit passcode).
4. **Guests** open the guest link, claim a spot, get the address, a Google Maps navigation button, and the passcode to show the neighbor.

## Two modes

### Link Mode (default, $0, no accounts anywhere)
Data travels inside the share links and back via WhatsApp; the host dashboard lives in the host's browser. Works on any static host. Good enough for one neighborhood and occasional events.

### Live Mode (recommended once real neighbors use it)
Add a free Supabase project so offers and claims sync for everyone in real time — no "send the link back" step.

1. Create a free project at supabase.com.
2. SQL Editor → paste `supabase-schema.sql` → Run.
3. Project Settings → API: copy the Project URL and the `anon` public key into `config.js`.
4. Redeploy. The footer of the app will say "Live Mode".

## Deploy (pick one, all free)

**Vercel:** vercel.com → Add New → Project → import this folder/repo → Deploy. No build settings needed (static site, `vercel.json` included).

**Netlify:** app.netlify.com → Add new site → Deploy manually → drag this folder in (`netlify.toml` included).

**GitHub Pages:** push this folder to a repo → Settings → Pages → deploy from branch.

Maps: Leaflet + OpenStreetMap tiles and Nominatim geocoding — all free, no API key. "Navigate" buttons hand off to Google Maps via its free directions URL (no key needed).

## Privacy
- Neighbor phone numbers are only shown to the host.
- A guest sees a spot's exact address in the guest link the host chose to share, and the passcode only after claiming.
- In Link Mode nothing is stored on any server — links contain the event/offer data, so treat them like the WhatsApp group itself: neighborhood-only.

## Files
- `index.html`, `styles.css`, `app.js` — the app (vanilla JS, no build step)
- `config.js` — Supabase keys for Live Mode (blank = Link Mode)
- `supabase-schema.sql` — database tables + public-link policies
