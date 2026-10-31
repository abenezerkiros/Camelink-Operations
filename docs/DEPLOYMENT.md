# Deploy CAMELINK Operations

Use this package as the new combined backend source of truth. Keep your existing mobile projects, approved sender configuration and Firebase project. No demo migration/import is needed.

## 1. Install

Use Node.js 22 LTS:

```bash
npm ci
npm --prefix backend ci
cp .env.example .env.local
```

Keep the Firebase public values already supplied for `camelink-pilot`. Add `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` from your Mapbox account. Create a public token with the standard map/style/font read scopes, and restrict its URLs to localhost for development and the exact production dashboard origins. Do not use an `sk.` secret token. Search uses Mapbox Geocoding v6; the token/account must allow that API. Search requests are submitted explicitly rather than on every keystroke. Geocoding results are used only in memory, not persisted.

## 2. Enable email/password and create the operator identity

Firebase Console → `camelink-pilot` → Authentication → Sign-in method → enable Email/Password. Create a separate operator account under Authentication → Users → Add user using your email and a strong password. Do not reuse a driver/customer identity. The dashboard has password reset and no public sign-up.

Authentication → Settings → Authorized domains: include localhost for local use and your final dashboard domain. Configure email templates for password reset if desired.

## 3. Grant trusted operator access

The account needs BOTH a trusted boolean `operator` or `admin` custom claim and `operators/{uid}.enabled = true`. The packaged script sets them from a trusted administrator environment. Browser code cannot grant access.

Authenticate the Google Cloud CLI as a project administrator using Application Default Credentials:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project camelink-pilot
GCLOUD_PROJECT=camelink-pilot node backend/scripts/operator-account.cjs grant your-email@example.com "Your Name"
```

The Google account must have Firebase Authentication administration and Firestore write permissions. Alternatively, use `GOOGLE_APPLICATION_CREDENTIALS` pointing to an administrator service-account JSON kept OUTSIDE the project and outside Git. Do not put credentials in `NEXT_PUBLIC_*`, upload them with the app, or paste them into chat.

To immediately remove operator data access:

```bash
GCLOUD_PROJECT=camelink-pilot node backend/scripts/operator-account.cjs revoke your-email@example.com
```

Sign out and back in after granting claims. Simply creating an Authentication user is not enough. The `operators` record also provides immediate revocation independently of token refresh.

## 4. Deploy the combined backend and rules

Copy your existing sender settings into `backend/.env.camelink-pilot`; a `backend/.env.example` is included. Preserve your approved sender name and identifier. Your existing `AFROMESSAGE_API_KEY` Firebase secret is reused. If not already set:

```bash
npx firebase functions:secrets:set AFROMESSAGE_API_KEY --project camelink-pilot
```

Then:

```bash
npx firebase login
npm run backend:build
npx firebase deploy --only functions,firestore:rules --project camelink-pilot
```

The `camelink` codebase contains the existing customer and driver functions plus the operator endpoints. Do not accept deletion of unrelated functions from another codebase. If you have changed the backend locally since the original mobile ZIP, merge those changes first.

Functions use europe-west1 / Node.js 22 and require the project's Blaze billing. The backend retains OTP rate limits and Secret Manager usage. Operator registration, live records and assignment do not depend on the SMS sender, but real customer/driver OTP login does.

The new Firestore rules let approved operators read operational records. Customers still read only their own customer-safe projections, drivers only their profile and assigned trips, and only operators can read GPS. All client-side writes to operational collections are denied; use the callable endpoints.

## 5. Run and verify locally

```bash
npm run dev
```

Sign in at http://localhost:3000. Expect an empty workspace until real records exist. Create a driver with their registered phone, truck plate, type and capacity. Customer accounts must be registered through the Customer app. If using an already-existing driver/customer account, it should appear automatically.

A driver must log into a native build configured for Firebase, grant location permission and go online before the map can show a fresh position. Search a location, choose a radius, call the driver, and assign an awaiting-review shipment. Confirm the trip appears on Driver and milestones appear on Customer. Test delivery returning availability. A map alone does not prove background GPS works; test the phone locked and app backgrounded too.

## 6. Host the Next.js app

Push the source to your private Git repository and import into Vercel (or another Node.js Next.js host). Use Node 22, root directory as this folder, install `npm ci`, build `npm run build`.

Set every `NEXT_PUBLIC_*` value from `.env.local` in hosting environment variables. These are public browser configuration values, not server credentials. They are embedded at build time, so rebuild after changing them. Keep `NEXT_PUBLIC_USE_EMULATORS=false` in production. No Firebase Admin or AfroMessage secrets belong in the web host.

Add the production domain to Firebase Authorized domains and your Mapbox token's URL restrictions, then redeploy if environment variables changed. Open the deployed URL and verify operator login, actual shipment reads, a real GPS marker and an authorized assignment. The previous ChatGPT-hosted preview remains a demo and should not be used for dispatch.

## Troubleshooting

- **No operator access:** confirm the claim AND enabled profile using the grant script; sign out and back in.
- **Missing/insufficient permissions:** deploy this package's `firestore.rules`; ensure you are in the same Firebase project.
- **Function not found / internal error:** deploy the combined backend in europe-west1 and review Firebase Functions logs. Do not switch to mock data.
- **No trucks on map:** check the driver is on Firebase mode, has a native build with GPS permissions, and `driverLocations/{uid}` contains finite latitude/longitude and recent recordedAt/receivedAt timestamps. Offline/stale records are not eligible for assignment.
- **Mapbox error:** check public token, API access, billing and allowed URLs; browser WebGL support is required.
- **Concurrent update error:** close the drawer and reopen the latest record before resubmitting.
- **No push on a device:** confirm its Expo push token is registered, permission granted and project credentials configured. Review pushTickets and notificationLogs. Gateway acceptance is not final OS delivery.
