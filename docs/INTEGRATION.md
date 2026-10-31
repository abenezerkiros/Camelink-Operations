# Shared contracts and endpoints

Live project: `camelink-pilot`; region: `europe-west1`.

The dashboard joins `customerShipments` with `operationsShipments` for assigned driver IDs. The customer projection never contains GPS or driver contact details. Drivers are read from `drivers`, approvals from `trucks`, latest GPS from `driverLocations`; last positions are evaluated against current time every 15 seconds. Data is held in browser memory, with no localStorage operational database and no silent fallback.

## Existing endpoints retained

All original customer and driver callables and push triggers remain exported. Existing operatorCreateDriver, operatorAssignTrip and operatorCancelTrip now also require an enabled `operators/{uid}` profile. New account creation rejects phones belonging to customer identities. Assignment uses transactional eligibility checks and validates finite timestamp freshness. The driver trigger also responds to cargo/status edits.

## New operator callables

All require an enabled trusted operator/admin. New commands take a UUID `requestId`, stored with a fingerprint to prevent duplicate or different reuse. IDs are generated once for retry of the same UI payload.

- `operatorCreateShipment({requestId,customerId,cargo})`
- `operatorEditShipment({requestId,shipmentId,cargo,reason,expectedUpdatedAt})`
- `operatorUpdateMilestone({requestId,shipmentId,status,reason,expectedUpdatedAt})`
- `operatorReassignTrip({requestId,shipmentId,driverId,phoneConfirmed,reason,expectedUpdatedAt})`
- `operatorUpdateDriver({requestId,driverId,fullName,phone,truckPlate,truckType,capacity,approved,reason,expectedUpdatedAt})` — `phone` must match the existing login number; changes are not accepted.
- `operatorSetDriverEnabled({requestId,driverId,enabled,reason,expectedUpdatedAt})`

Existing `operatorAssignTrip` and `operatorCancelTrip` accept `expectedUpdatedAt` for optimistic conflict checks. Their existing server state guards prevent duplicate state changes; a retry after success may report that the trip is already assigned/closed. Refresh the live record after a timeout.

Reassignment writes an archived old-driver assignment under a unique ID, marks it cancelled/reassigned, changes ownership of the canonical driver trip, and atomically changes both driver active-trip pointers. The customer shipment retains its milestone. Security rules immediately remove the old driver's access to the canonical record. Old queued driver updates are rejected by ownership checks.

See DEPLOYMENT.md for setup and VERIFICATION.md for tested and untested behavior.
