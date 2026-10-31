# CAMELINK Operations — live Firebase + Mapbox dashboard

This replaces the earlier browser-local demonstration. It is a Next.js App Router / React application that signs operators in with Firebase email/password, reads live data, searches and displays real locations using Mapbox, and calls the shared Firebase backend for every write. There is no demo mode or generated operational data.

## Quick start

Use Node.js 22 LTS. From this folder:

```bash
npm ci
npm --prefix backend ci
cp .env.example .env.local
```

The Firebase public configuration for `camelink-pilot` is already in `.env.example`. Add your **public Mapbox access token** to `.env.local`. Enable Firebase email/password sign-in, provision your operator account, and deploy the included shared backend and rules as described in **docs/DEPLOYMENT.md**. Then:

```bash
npm run dev
```

Open http://localhost:3000. Sign in using the operator email/password you created. The workspace starts empty until customers and drivers create real activity. No shared sample login is included.

## Included

- Real Firebase email/password login, password reset, session-only auth persistence and sign-out.
- Trusted operator/admin claims plus a server-controlled enabled operator profile; UI, Firestore rules and backend all enforce access.
- Live Firestore shipment, customer, fleet, GPS and activity subscriptions with loading, empty, error and connection states.
- Mapbox GL JS map, location search using the Mapbox Geocoding API, radius filters (10–250 km), driver/truck filters, markers, accuracy and GPS freshness.
- Phone-confirmed direct assignment; no accept/decline step.
- Operator driver creation with an approved truck, edit/approval changes, suspension and re-enabling.
- All 16 original optional cargo fields, existing-customer phone requests, shipment correction, cancellation, reassignment and milestone overrides.
- Transactions for ownership and status changes; stale edit rejection and deduplication for new operator command endpoints.
- Shared customer/driver projections and existing Expo push triggers. Driver trip changes now notify the driver; reassignment archives the prior assignment and notifies both drivers through their respective records.
- Delivery automatically releases the driver and returns them online.
- Server-written audit history and CSV export.
- Combined customer + driver + operator backend and Firestore security rules; preserve this combined backend for future deployments.

## Structure

`app/` holds Next.js layout/entry/styles. `components/OperatorSession.jsx` handles auth; `OperationsDashboard.jsx` renders the authenticated workspace; `OperationsDrawer.jsx` contains server-backed forms; `FleetMap.jsx` owns Mapbox. `lib/firebase.js` initializes clients/callables; `lib/useOperations.js` subscribes to data; `lib/live-model.js` maps the existing backend contracts. `backend/src/` contains the complete Firebase Functions source. `shared/` retains the mobile contracts.

The backend is in this ZIP so you can deploy the required changes. No backend or mobile release has been deployed on your behalf. Do not deploy the old customer-only backend after this package: it lacks the driver/operator functions.

## Build and tests

```bash
npm run backend:build
npm test
npm run test:integration
npm run build
npm start
```

Integration tests require Java 17+ with the pinned Firebase CLI 14 (Java 21 recommended). They start isolated Auth and Firestore emulators under `demo-camelink` and do not contact the live project. The function handlers use real emulator transactions; Firestore security rules are evaluated by the emulator. No real SMS or push messages are sent.

## Pilot boundaries

- Dashboard subscriptions show up to 2,000 documents per operational collection and the most recent 500 audit events. A warning appears at the limit. Add indexed pagination/geospatial query endpoints before operating beyond this scale. Radius filtering occurs in the authorized operator browser; GPS is never made public.
- The driver must be enabled, online, linked to an approved truck, free of active trips and have GPS recorded AND received within three minutes. Old positions can remain visible as stale, but cannot be assigned.
- Customer login is self-service OTP; driver login is operator-created phone OTP. Operator accounts use email/password only.
- Registered driver login numbers are immutable in this UI. A verified Admin SDK migration is needed to change both Firebase Auth and the private phone lookup safely. The dashboard explicitly labels the field read-only.
- Closed shipments cannot be reopened or edited. Reassignment retains a cancelled old-driver assignment marked `reassigned:true` while the cargo owner's shipment continues. Existing mobile apps may label that historical assignment simply “Cancelled”.
- Push triggers send through Expo and remove invalid tokens on gateway response. Final push receipt reconciliation is not implemented; OS delivery is not guaranteed. Test real push and background tracking on physical devices before starting paid operations.
- A build passing does not mean your live project is configured. Mapbox token validity, production login, deployed callables, SMS sender approval and end-to-end physical-device behavior require your credentials and environment. See docs/VERIFICATION.md for checks actually run.

The previous hosted demo URL is not upgraded by extracting or deploying this ZIP. Deploy this Next.js app to your own hosting and use that URL for real operations.
