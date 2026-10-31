# Verification — live dashboard edition

Verified in this environment:

- Next.js optimized production build compiles and prerenders successfully.
- The production login page renders its email/password form in the browser.
- Combined Firebase Functions TypeScript build passes.
- Four unit tests pass: CSV quoting/formula safety, coordinate freshness, truck ownership and geographic radius calculation.
- Ten Auth/Firestore emulator integration tests pass: unauthorized mutations; driver creation/collision; offline/stale GPS; concurrent assignment; edit idempotency and stale-version conflicts; reassignment ownership/history; old-driver mutation rejection; delivery release; suspension; role-based read/write rules and cross-customer/driver privacy. Several test cases contain multiple assertions.

The integration suite calls the actual exported callable handlers with authenticated request objects against emulator databases. It verifies rules with the Firebase rules testing SDK. It does not exercise deployed HTTPS transport, the actual production project, trigger delivery, actual email sending, AfroMessage or Expo push. No live project credentials were used for mutations and no production data was changed.

Not yet verified with your environment:

- Successful operator login with your real account and deployed claims/profile.
- Mapbox token validity, rendered production tiles and actual geocoding response.
- Real driver GPS updates with the app backgrounded, location permissions and power-saving modes.
- Assignment and milestone propagation across all three installed products, push notifications and SMS OTP.
- Live Firebase Functions deployment, billing configuration, production Firestore rules and production hosting domains.

These require the deployment and physical-device checks in DEPLOYMENT.md. Backend approval checks do not replace a real end-to-end pilot test.
