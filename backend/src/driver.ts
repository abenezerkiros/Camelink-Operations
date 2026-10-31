import {requireOperator as operator} from "./operator-auth";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import {
  onCall,
  HttpsError,
  type CallableRequest,
} from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import { createHash, randomUUID } from "node:crypto";
import { geohashForLocation } from "geofire-common";
import {
  normalizePhone,
  type Shipment,
  type Status,
} from "../../shared/contracts";
import {
  assertMilestone,
  validateFix,
  type DriverProfile,
  type DriverTrip,
} from "../../shared/driver";
if (!getApps().length) initializeApp();
const db = getFirestore(),
  auth = getAuth();
const opts = { region: "europe-west1", maxInstances: 10 };
const secret = defineSecret("AFROMESSAGE_API_KEY");
const sender = {
  value: () => process.env.AFROMESSAGE_SENDER || "",
};
const identifier = {
  value: () => process.env.AFROMESSAGE_IDENTIFIER || "",
};
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
function fail(message: string): never {
  throw new HttpsError("failed-precondition", message);
}
function id(v: unknown) {
  if (typeof v !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(v))
    throw new HttpsError("invalid-argument", "Invalid record ID.");
  return v;
}
function uid(r: CallableRequest) {
  if (!r.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  return r.auth.uid;
}
async function driver(r: CallableRequest) {
  const u = uid(r),
    snap = await db.doc(`drivers/${u}`).get();
  const p = snap.data() as DriverProfile | undefined;
  if (!p?.enabled)
    throw new HttpsError(
      "permission-denied",
      "Driver account unavailable. Contact operations.",
    );
  return p;
}
async function rate(key: string, max: number, ms: number) {
  const ref = db.doc("rateLimits/" + hash("driver:" + key)),
    now = Date.now();
  await db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data(),
      s = d && d.until > now ? d : { count: 0, until: now + ms };
    if (s.count >= max)
      throw new HttpsError(
        "resource-exhausted",
        "Too many attempts. Try again later.",
      );
    tx.set(ref, { count: s.count + 1, until: s.until });
  });
}
async function afro(path: string, params: Record<string, string>) {
  const u = new URL("https://api.afromessage.com/api/" + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v) u.searchParams.set(k, v);
  });
  let r: Response;
  try {
    r = await fetch(u, {
      headers: { Authorization: "Bearer " + secret.value() },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new HttpsError("unavailable", "SMS service unavailable.");
  }
  if (!r.ok) throw new HttpsError("unavailable", "SMS service unavailable.");
  const body = (await r.json()) as {
    acknowledge: string;
    response: { verificationId?: string };
  };
  if (body.acknowledge !== "success")
    throw new HttpsError(
      "invalid-argument",
      path === "verify"
        ? "Invalid or expired code."
        : "Unable to send code. Contact operations.",
    );
  return body.response;
}
export const requestDriverOtp = onCall(
  { ...opts, secrets: [secret] },
  async (r) => {
    let phone: string;
    try {
      phone = normalizePhone(r.data?.phone || "");
    } catch {
      throw new HttpsError("invalid-argument", "Enter a valid phone number.");
    }
    await rate("ip:" + (r.rawRequest.ip || "unknown"), 20, 3600000);
    await rate("phone:" + phone, 5, 3600000);
    await rate("resend:" + phone, 1, 60000);
    const mapping = (await db.doc("driverPhones/" + hash(phone)).get()).data(),
      p = mapping
        ? (await db.doc("drivers/" + mapping.uid).get()).data()
        : null;
    if (!p?.enabled)
      throw new HttpsError(
        "permission-denied",
        "This number is not enabled for driver login. Contact operations.",
      );
    const response = await afro("challenge", {
      to: phone,
      from: identifier.value(),
      sender: sender.value(),
      len: "6",
      t: "0",
      ttl: "300",
      pr: "Your CAMELINK driver code is",
      sb: "1",
    });
    if (!response.verificationId) fail("Unable to start verification.");
    const challengeId = randomUUID();
    await db
      .doc("driverOtpChallenges/" + challengeId)
      .set({
        uid: mapping!.uid,
        phone,
        verificationId: response.verificationId,
        expiresAt: Date.now() + 300000,
        state: "pending",
        attempts: 0,
      });
    return { challengeId };
  },
);
export const verifyDriverOtp = onCall(
  { ...opts, secrets: [secret] },
  async (r) => {
    const challengeId = id(r.data?.challengeId),
      code = r.data?.code;
    if (typeof code !== "string" || !/^\d{6}$/.test(code))
      throw new HttpsError("invalid-argument", "Enter six digits.");
    await rate("verify-ip:" + (r.rawRequest.ip || "unknown"), 60, 3600000);
    const ref = db.doc("driverOtpChallenges/" + challengeId);
    const d = await db.runTransaction(async (tx) => {
      const c = (await tx.get(ref)).data();
      if (
        !c ||
        c.expiresAt < Date.now() ||
        c.state !== "pending" ||
        c.attempts >= 5
      )
        fail("Code expired or already used.");
      tx.update(ref, { state: "verifying", attempts: c.attempts + 1 });
      return c;
    });
    try {
      await afro("verify", { vc: d.verificationId, code });
    } catch (e) {
      await ref.update({ state: "pending" });
      throw e;
    }
    await ref.update({ state: "consumed" });
    const p = (await db.doc("drivers/" + d.uid).get()).data(),
      mapping = (await db.doc("driverPhones/" + hash(d.phone)).get()).data();
    if (!p?.enabled || p.phone !== d.phone || mapping?.uid !== d.uid)
      throw new HttpsError(
        "permission-denied",
        "Driver account changed. Contact operations.",
      );
    const user = await auth.getUser(d.uid);
    if (
      user.disabled ||
      user.customClaims?.operator ||
      user.customClaims?.admin ||
      ["admin", "operator"].includes(user.customClaims?.role)
    )
      throw new HttpsError(
        "permission-denied",
        "Account unavailable for driver login.",
      );
    return { token: await auth.createCustomToken(d.uid) };
  },
);
export const driverProfile = onCall(opts, driver);
export const setDriverOnline = onCall(opts, async (r) => {
  const u = uid(r),
    online = r.data?.online;
  if (typeof online !== "boolean")
    throw new HttpsError("invalid-argument", "Invalid availability.");
  let fix: ReturnType<typeof validateFix> | undefined;
  try {
    fix = online ? validateFix(r.data.fix) : undefined;
  } catch {
    fail("Obtain a fresh GPS fix before going online.");
  }
  const ref = db.doc("drivers/" + u);
  await db.runTransaction(async (tx) => {
    const p = (await tx.get(ref)).data() as DriverProfile | undefined;
    if (!p?.enabled)
      throw new HttpsError("permission-denied", "Driver access unavailable.");
    if (!online && p.activeTripId)
      fail(
        "Finish the active trip or contact operations before going offline.",
      );
    const truck = (await tx.get(db.doc("trucks/" + p.truckId))).data();
    if (online && (!truck?.approved || truck.driverId !== u))
      fail("Your truck is not approved. Contact operations.");
    tx.update(ref, { online });
    if (fix)
      tx.set(db.doc("driverLocations/" + u), {
        ...fix,
        driverId: u,
        truckId: p.truckId,
        geohash: geohashForLocation([fix.latitude, fix.longitude]),
        receivedAt: Date.now(),
        online: true,
      });
    else
      tx.set(
        db.doc("driverLocations/" + u),
        { online: false, offlineAt: Date.now() },
        { merge: true },
      );
  });
  return { ok: true };
});
export const updateDriverLocation = onCall(opts, async (r) => {
  const u = uid(r);
  let fix: ReturnType<typeof validateFix>;
  try {
    fix = validateFix(r.data?.fix);
  } catch {
    fail("Location invalid or stale.");
  }
  await db.runTransaction(async (tx) => {
    const p = (await tx.get(db.doc("drivers/" + u))).data() as
      DriverProfile | undefined;
    if (!p?.enabled || (!p.online && !p.activeTripId))
      throw new HttpsError(
        "permission-denied",
        "Location sharing is not active.",
      );
    const ref = db.doc("driverLocations/" + u),
      old = (await tx.get(ref)).data();
    if (old?.recordedAt >= fix.recordedAt) return;
    tx.set(ref, {
      ...fix,
      driverId: u,
      truckId: p.truckId,
      tripId: p.activeTripId,
      online: p.online,
      geohash: geohashForLocation([fix.latitude, fix.longitude]),
      receivedAt: Date.now(),
    });
  });
  return { ok: true };
});
export const driverMilestone = onCall(opts, async (r) => {
  const u = uid(r),
    tripId = id(r.data?.id),
    eventId = id(r.data?.eventId),
    next = r.data?.status as Status;
  await db.runTransaction(async (tx) => {
    const pr = db.doc("drivers/" + u),
      tr = db.doc("driverTrips/" + tripId),
      sr = db.doc("customerShipments/" + tripId);
    const p = (await tx.get(pr)).data() as DriverProfile | undefined,
      t = (await tx.get(tr)).data() as DriverTrip | undefined,
      s = (await tx.get(sr)).data() as Shipment | undefined;
    if (!p?.enabled || !t || !s || t.driverId !== u)
      throw new HttpsError("permission-denied", "Trip is not assigned to you.");
    if (t.events.some((e) => e.id === eventId)) {
      if (t.events.find((e) => e.id === eventId)?.status !== next)
        fail("Event ID already used.");
      return;
    }
    if (
      p.activeTripId !== tripId ||
      p.truckId !== t.truckId ||
      s.status !== t.status
    )
      fail("Assignment has changed. Refresh the app.");
    try {
      assertMilestone(t.status, next);
    } catch {
      fail("Milestone is not the next step. Refresh the trip.");
    }
    const now = Date.now(),
      event = { id: eventId, status: next, at: now };
    tx.update(tr, {
      status: next,
      updatedAt: now,
      events: [...t.events, event],
    });
    tx.update(sr, {
      status: next,
      updatedAt: now,
      events: [...s.events, event],
    });
    if (next === "delivered")
      tx.update(pr, { activeTripId: null, online: true });
    tx.create(db.collection("auditLogs").doc(), {
      actor: u,
      action: "driver.milestone",
      shipmentId: tripId,
      status: next,
      at: now,
    });
  });
  return { ok: true };
});
export const registerDriverPush = onCall(opts, async (r) => {
  const p = await driver(r),
    token = r.data?.token;
  if (
    typeof token !== "string" ||
    !/^(ExponentPushToken|ExpoPushToken)\[[\w-]+\]$/.test(token)
  )
    throw new HttpsError("invalid-argument", "Invalid push token.");
  await db.doc("driverPushTokens/" + hash(token)).set({ uid: p.uid, token });
  return { ok: true };
});
export const removeDriverPush = onCall(opts, async (r) => {
  const p = await driver(r),
    token = r.data?.token;
  if (typeof token !== "string") fail("Invalid token.");
  const ref = db.doc("driverPushTokens/" + hash(token));
  await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).data()?.uid === p.uid) tx.delete(ref);
  });
  return { ok: true };
});
// Operator commands are server-only role checked entry points for the future dashboard.
export const operatorCreateDriver = onCall(opts, async (r) => {
  const actor = await operator(r);
  let phone: string;
  try {
    phone = normalizePhone(r.data?.phone || "");
  } catch {
    fail("Invalid phone number.");
  }
  const { fullName, truckPlate, truckType, capacity } = r.data || {};
  for (const v of [fullName, truckPlate, truckType, capacity])
    if (typeof v !== "string" || !v.trim() || v.length > 100)
      fail("Provide name, approved truck plate, type and capacity.");
  let user;
  try {
    user = await auth.getUserByPhoneNumber(phone);
  } catch (e) {
    if ((e as { code?: string }).code !== "auth/user-not-found") throw e;
    try {
      user = await auth.createUser({ phoneNumber: phone });
    } catch (e2) {
      if ((e2 as { code?: string }).code !== "auth/phone-number-already-exists")
        throw e2;
      user = await auth.getUserByPhoneNumber(phone);
    }
  }
  if (user.disabled || user.customClaims?.operator || user.customClaims?.admin)
    fail("This identity cannot be used as a driver.");
  if ((await db.doc(`customers/${user.uid}`).get()).exists) fail("This phone is registered to a customer. Use a separate driver number.");
  const truckId = hash(truckPlate.trim().toUpperCase()),
    profile: DriverProfile = {
      uid: user.uid,
      phone,
      fullName: fullName.trim(),
      enabled: true,
      truckId,
      truckPlate: truckPlate.trim(),
      truckType: truckType.trim(),
      capacity: capacity.trim(),
      online: false,
      activeTripId: null,
    };
  await db.runTransaction(async (tx) => {
    const pr = db.doc("drivers/" + user.uid),
      tr = db.doc("trucks/" + truckId),
      existing = (await tx.get(pr)).data(),
      customerExists = (await tx.get(db.doc(`customers/${user.uid}`))).exists,
      truck = (await tx.get(tr)).data();
    if (existing || truck || customerExists)
      fail(
        "Driver or truck already exists. Use the operator management workflow.",
      );
    tx.create(pr, profile);
    tx.create(tr, {
      id: truckId,
      driverId: user.uid,
      plate: profile.truckPlate,
      approved: true,
      approvedBy: actor,
      approvedAt: Date.now(),
    });
    tx.set(db.doc("driverPhones/" + hash(phone)), { uid: user.uid });
    tx.create(db.collection("auditLogs").doc(), {
      actor,
      action: "driver.created",
      driverId: user.uid,
      at: Date.now(),
    });
  });
  return profile;
});
export const operatorAssignTrip = onCall(opts, async (r) => {
  const actor = await operator(r),
    tripId = id(r.data?.shipmentId),
    driverId = id(r.data?.driverId);
  if (r.data?.phoneConfirmed !== true)
    fail("Confirm the arrangement by phone before assigning.");
  await db.runTransaction(async (tx) => {
    const pr = db.doc("drivers/" + driverId),
      sr = db.doc("customerShipments/" + tripId),
      tr = db.doc("driverTrips/" + tripId);
    const p = (await tx.get(pr)).data() as DriverProfile | undefined,
      s = (await tx.get(sr)).data() as Shipment | undefined,
      existing = (await tx.get(tr)).data(),
      loc = (await tx.get(db.doc("driverLocations/" + driverId))).data();
    if (!p?.enabled || !p.online || p.activeTripId)
      fail("Driver is not available.");
    if (s && r.data.expectedUpdatedAt !== undefined && s.updatedAt !== r.data.expectedUpdatedAt) fail("Shipment changed. Refresh before assigning.");
    if (!s || s.status !== "awaiting_review" || existing)
      fail("Shipment is already assigned or closed.");
    const truck = (await tx.get(db.doc("trucks/" + p.truckId))).data();
    if (!truck?.approved || truck.driverId !== driverId)
      fail("Truck approval mismatch.");
    if (
      !loc?.online ||
      !Number.isFinite(loc.receivedAt) || !Number.isFinite(loc.recordedAt) ||
      loc.receivedAt > Date.now()+60000 || loc.recordedAt > Date.now()+60000 ||
      Date.now() - loc.receivedAt > 180000 ||
      Date.now() - loc.recordedAt > 180000
    )
      fail("Location is stale. Ask the driver to restore tracking.");
    const now = Date.now(),
      event = { id: randomUUID(), status: "trip_started" as const, at: now };
    tx.create(tr, {
      ...s,
      driverId,
      truckId: p.truckId,
      status: "trip_started",
      updatedAt: now,
      events: [event],
    });
    tx.update(sr, {
      status: "trip_started",
      updatedAt: now,
      events: [...s.events, event],
    });
    tx.update(pr, { activeTripId: tripId });
    tx.set(
      db.doc("operationsShipments/" + tripId),
      { driverId, truckId: p.truckId, assignedBy: actor, assignedAt: now },
      { merge: true },
    );
    tx.create(db.collection("auditLogs").doc(), {
      actor,
      action: "trip.assigned",
      shipmentId: tripId,
      driverId,
      at: now,
    });
  });
  return { ok: true };
});
export const operatorCancelTrip = onCall(opts, async (r) => {
  const actor = await operator(r),
    tripId = id(r.data?.shipmentId),
    reason = r.data?.reason;
  if (typeof reason !== "string" || !reason.trim() || reason.length > 1000)
    fail("Record a cancellation reason.");
  await db.runTransaction(async (tx) => {
    const sr = db.doc("customerShipments/" + tripId),
      tr = db.doc("driverTrips/" + tripId);
    const s = (await tx.get(sr)).data() as Shipment | undefined,
      t = (await tx.get(tr)).data() as DriverTrip | undefined;
    if (!s || ["delivered", "cancelled"].includes(s.status))
      fail("Shipment is already closed.");
    if (r.data.expectedUpdatedAt !== undefined && s.updatedAt !== r.data.expectedUpdatedAt) fail("Shipment changed. Refresh before cancelling.");
    const pr = t ? db.doc("drivers/" + t.driverId) : null,
      p = pr ? (await tx.get(pr)).data() : null;
    const now = Date.now(),
      event = { id: randomUUID(), status: "cancelled" as const, at: now };
    tx.update(sr, {
      status: "cancelled",
      updatedAt: now,
      events: [...s.events, event],
    });
    if (t)
      tx.update(tr, {
        status: "cancelled",
        updatedAt: now,
        events: [...t.events, event],
      });
    if (pr && p?.activeTripId === tripId) tx.update(pr, { activeTripId: null });
    tx.create(db.collection("auditLogs").doc(), {
      actor,
      action: "trip.cancelled",
      shipmentId: tripId,
      reason,
      at: now,
    });
  });
  return { ok: true };
});
export const notifyDriver = onDocumentWritten(
  { ...opts, document: "driverTrips/{id}", retry: true },
  async (e) => {
    const after = e.data?.after.data() as DriverTrip | undefined,
      before = e.data?.before.data() as DriverTrip | undefined;
    if (
      !after ||
      (before &&
        after.status === before.status &&
        before.driverId === after.driverId &&
        JSON.stringify(before.cargo) === JSON.stringify(after.cargo))
    )
      return;
    const ref = db.doc("notificationLogs/driver-" + e.id);
    if ((await ref.get()).exists) return;
    const tokens = await db
      .collection("driverPushTokens")
      .where("uid", "==", after.driverId)
      .get();
    for (let i = 0; i < tokens.size; i += 100) {
      const batch = tokens.docs.slice(i, i + 100),
        r = await fetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            batch.map((t) => ({
              to: t.data().token,
              title:
                after.status === "cancelled"
                  ? "Trip cancelled"
                  : before && before.driverId === after.driverId ? "Trip updated" : "Trip started",
              body: "Operations updated your trip. Open CAMELINK Driver for details.",
              data: { tripId: after.id },
              sound: "default",
              channelId: "trips",
            })),
          ),
        });
      if (!r.ok) throw Error("Push gateway unavailable");
      const result = (await r.json()) as {
        data?: Array<{
          status: string;
          id?: string;
          details?: { error?: string };
        }>;
      };
      for (const [j, t] of (result.data || []).entries()) {
        await db
          .collection("pushTickets")
          .add({ ...t, eventId: e.id, app: "driver", at: Date.now() });
        if (t.details?.error === "DeviceNotRegistered")
          await batch[j].ref.delete();
      }
    }
    await ref.set({ at: Date.now(), tripId: after.id });
  },
);
