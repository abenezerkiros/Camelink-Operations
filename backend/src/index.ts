import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import {
  onCall,
  HttpsError,
  CallableRequest,
} from "firebase-functions/v2/https";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import { createHash, randomUUID } from "node:crypto";
import {
  normalizePhone,
  validateCargo,
  LABELS,
  Shipment,
  Profile,
} from "../../shared/contracts";
if (!getApps().length) initializeApp();
const db = getFirestore(),
  auth = getAuth();
  const secret = defineSecret("AFROMESSAGE_API_KEY");
  const sender = {
    value: () => process.env.AFROMESSAGE_SENDER || "",
  };
  const from = {
    value: () => process.env.AFROMESSAGE_IDENTIFIER || "",
  };
const region = "europe-west1",
  options = { region, maxInstances: 10 };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function invalid(message: string): never {
  throw new HttpsError("invalid-argument", message);
}
function phone(value: unknown) {
  try {
    return normalizePhone(typeof value === "string" ? value : "");
  } catch {
    return invalid("Enter a valid phone number.");
  }
}
async function customer(req: CallableRequest) {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in.");
  const p = await db.doc(`customers/${req.auth.uid}`).get();
  if (!p.exists)
    throw new HttpsError("permission-denied", "Customer account required.");
  return p.data() as Profile;
}
async function rate(key: string, max: number, window: number) {
  const ref = db.doc(`rateLimits/${hash(key)}`),
    now = Date.now();
  await db.runTransaction(async (tx) => {
    const data = (await tx.get(ref)).data();
    const current =
      data && data.until > now ? data : { count: 0, until: now + window };
    if (current.count >= max)
      throw new HttpsError(
        "resource-exhausted",
        "Too many attempts. Please try again later.",
      );
    tx.set(ref, { count: current.count + 1, until: current.until });
  });
}
async function afro(path: string, params: Record<string, string>) {
  const url = new URL("https://api.afromessage.com/api/" + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v) url.searchParams.set(k, v);
  });
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${secret.value()}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new HttpsError(
      "unavailable",
      "SMS service is temporarily unavailable. Please try again.",
    );
  }
  if (!response.ok)
    throw new HttpsError(
      "unavailable",
      "SMS service is temporarily unavailable.",
    );
  const data = (await response.json()) as {
    acknowledge: string;
    response: { verificationId?: string };
  };
  if (data.acknowledge !== "success")
    throw new HttpsError(
      path === "verify" ? "invalid-argument" : "unavailable",
      path === "verify"
        ? "The code is invalid or expired."
        : "Unable to send your code. Please try again later.",
    );
  return data.response;
}
export const requestCustomerOtp = onCall(
  { ...options, secrets: [secret] },
  async (req) => {
    const to = phone(req.data?.phone),
      ip = req.rawRequest.ip || "unknown";
    await rate("otp-ip:" + ip, 20, 3600000);
    await rate("otp-phone:" + to, 5, 3600000);
    await rate("otp-resend:" + to, 1, 60000);
    const result = await afro("challenge", {
      to,
      from: from.value(),
      sender: sender.value(),
      len: "6",
      t: "0",
      ttl: "300",
      pr: "Your CAMELINK verification code is",
      sb: "1",
      ps: ". Do not share this code.",
      sa: "0",
    });
    if (!result.verificationId)
      throw new HttpsError(
        "unavailable",
        "SMS verification could not be initialized.",
      );
    const challengeId = randomUUID();
    await db.doc(`otpChallenges/${challengeId}`).set({
      phone: to,
      verificationId: result.verificationId,
      expiresAt: Date.now() + 300000,
      attempts: 0,
      state: "pending",
    });
    // Never return the OTP, provider response, or provider verification ID to the device.
    return { challengeId };
  },
);
export const verifyCustomerOtp = onCall(
  { ...options, secrets: [secret] },
  async (req) => {
    const { challengeId, code } = req.data || {};
    if (
      typeof challengeId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(challengeId) ||
      typeof code !== "string" ||
      !/^\d{6}$/.test(code)
    )
      invalid("Enter the six-digit code.");
    await rate("verify-ip:" + (req.rawRequest.ip || "unknown"), 60, 3600000);
    const ref = db.doc(`otpChallenges/${challengeId}`),
      now = Date.now();
    const challenge = await db.runTransaction(async (tx) => {
      const d = (await tx.get(ref)).data();
      if (!d || d.expiresAt < now || d.state !== "pending" || d.attempts >= 5)
        throw new HttpsError(
          "failed-precondition",
          "Code expired or already used. Request a new one.",
        );
      tx.update(ref, { state: "verifying", attempts: d.attempts + 1 });
      return d;
    });
    try {
      await afro("verify", { vc: challenge.verificationId, code });
    } catch (e) {
      await ref.update({ state: "pending" });
      throw e;
    }
    // Consume before issuing a token. A challenge cannot authenticate twice.
    await ref.update({ state: "consumed", consumedAt: Date.now() });
    let user;
    try {
      user = await auth.getUserByPhoneNumber(challenge.phone);
    } catch (e) {
      if ((e as { code?: string }).code !== "auth/user-not-found") throw e;
      try {
        user = await auth.createUser({ phoneNumber: challenge.phone });
      } catch (createError) {
        if (
          (createError as { code?: string }).code !==
          "auth/phone-number-already-exists"
        )
          throw createError;
        user = await auth.getUserByPhoneNumber(challenge.phone);
      }
    }
    if (user.disabled)
      throw new HttpsError(
        "permission-denied",
        "This account is disabled. Contact operations.",
      );
    // Never issue privileged claims through public customer authentication.
    if (
      user.customClaims?.operator ||
      user.customClaims?.admin ||
      user.customClaims?.role === "operator" ||
      user.customClaims?.role === "admin"
    )
      throw new HttpsError("permission-denied", "Use the operator sign-in.");
    if ((await db.doc(`drivers/${user.uid}`).get()).exists) throw new HttpsError("permission-denied", "Use the driver app with this number.");
    const p = db.doc(`customers/${user.uid}`);
    await db.runTransaction(async (tx) => {
      if (!(await tx.get(p)).exists)
        tx.create(p, { uid: user.uid, phone: challenge.phone, fullName: "" });
    });
    return { token: await auth.createCustomToken(user.uid) };
  },
);
export const customerProfile = onCall(options, async (req) => customer(req));
export const saveCustomerName = onCall(options, async (req) => {
  const p = await customer(req),
    name = req.data?.fullName;
  if (typeof name !== "string" || !name.trim() || name.length > 100)
    invalid("Enter your full name.");
  const result = { ...p, fullName: name.trim() };
  await db.doc(`customers/${p.uid}`).set(result);
  return result;
});
export const createCustomerShipment = onCall(options, async (req) => {
  const p = await customer(req);
  if (!p.fullName)
    throw new HttpsError("failed-precondition", "Complete your profile first.");
  const id = req.data?.requestId;
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
    invalid("Invalid request ID.");
  let cargo;
  try {
    cargo = validateCargo(req.data?.cargo);
  } catch {
    invalid("Invalid shipment fields.");
  }
  const ref = db.doc(`customerShipments/${id}`),
    now = Date.now();
  return db.runTransaction(async (tx) => {
    const old = await tx.get(ref);
    if (old.exists) {
      const existing = old.data() as Shipment;
      if (existing.customerId !== p.uid)
        throw new HttpsError("permission-denied", "Invalid request.");
      return existing;
    }
    const shipment: Shipment = {
      id,
      reference: "CML-" + id.toUpperCase(),
      customerId: p.uid,
      cargo,
      status: "awaiting_review",
      createdAt: now,
      updatedAt: now,
      events: [{ id: "created", status: "awaiting_review", at: now }],
    };
    tx.create(ref, shipment);
    tx.create(db.doc(`operationsShipments/${id}`), {
      shipmentId: id,
      customerId: p.uid,
      driverId: null,
      truckId: null,
      createdAt: now,
    });
    tx.create(db.collection("auditLogs").doc(), {
      actor: p.uid,
      action: "shipment.created",
      shipmentId: id,
      at: now,
    });
    return shipment;
  });
});
export const registerCustomerPush = onCall(options, async (req) => {
  const p = await customer(req),
    token = req.data?.token;
  if (
    typeof token !== "string" ||
    !/^(ExponentPushToken|ExpoPushToken)\[[\w-]+\]$/.test(token)
  )
    invalid("Invalid push token.");
  await db
    .doc(`pushTokens/${hash(token)}`)
    .set({ uid: p.uid, token, updatedAt: Date.now() });
  return { ok: true };
});
export const removeCustomerPush = onCall(options, async (req) => {
  const p = await customer(req),
    token = req.data?.token;
  if (typeof token !== "string") invalid("Invalid token.");
  const ref = db.doc(`pushTokens/${hash(token)}`);
  await db.runTransaction(async (tx) => {
    const d = await tx.get(ref);
    if (d.data()?.uid === p.uid) tx.delete(ref);
  });
  return { ok: true };
});
export const notifyCustomer = onDocumentUpdated(
  { ...options, document: "customerShipments/{id}", retry: true },
  async (event) => {
    const before = event.data?.before.data() as Shipment | undefined,
      after = event.data?.after.data() as Shipment | undefined;
    if (
      !before ||
      !after ||
      JSON.stringify(before.events) === JSON.stringify(after.events)
    )
      return;
    const log = db.doc(`notificationLogs/${event.id}`);
    if ((await log.get()).data()?.state === "sent") return;
    const tokens = await db
      .collection("pushTokens")
      .where("uid", "==", after.customerId)
      .get();
    for (let i = 0; i < tokens.docs.length; i += 100) {
      const batch = tokens.docs.slice(i, i + 100);
      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          batch.map((t) => ({
            to: t.data().token,
            title: "Shipment update",
            body: `${after.reference}: ${LABELS[after.status]}`,
            data: { shipmentId: after.id },
            sound: "default",
            channelId: "shipments",
          })),
        ),
      });
      if (!response.ok) throw Error("Push gateway unavailable");
      const result = (await response.json()) as {
        data?: Array<{
          status: string;
          id?: string;
          details?: { error?: string };
        }>;
      };
      for (const [j, ticket] of (result.data || []).entries()) {
        await db.collection("pushTickets").add({
          eventId: event.id,
          shipmentId: after.id,
          ...ticket,
          createdAt: Date.now(),
        });
        if (ticket.details?.error === "DeviceNotRegistered")
          await batch[j].ref.delete();
      }
    }
    await log.set({
      state: "sent",
      at: Date.now(),
      shipmentId: after.id,
      tokenCount: tokens.size,
    });
  },
);

export * from "./driver";

export * from "./operations";
