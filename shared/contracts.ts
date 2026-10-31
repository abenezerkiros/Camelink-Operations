/** Customer-safe contract shared by all three CAMELINK products. Never add GPS here. */
export const FIELDS = [
  ["itemLoaded", "Item to be loaded"],
  ["itemType", "Item type"],
  ["itemQuantity", "Item quantity"],
  ["storageRequirement", "Item storage requirement"],
  ["loadingRequirement", "Loading & offloading requirement"],
  ["loadingCosts", "Loading & offloading costs"],
  ["loadingDate", "Loading date"],
  ["offloadingDate", "Offloading date"],
  ["destination", "Destination location"],
  ["departure", "Departure location"],
  ["distance", "Distance in total"],
  ["roadCondition", "Type of road condition"],
  ["loadingArea", "Area of loading"],
  ["destinationArea", "Area of destination"],
  ["securitySituation", "Security situation"],
  ["demurrageDate", "Offloading demurrage date"],
] as const;
export type Field = (typeof FIELDS)[number][0];
export type Cargo = Record<Field, string>;
export const emptyCargo = (): Cargo =>
  Object.fromEntries(FIELDS.map(([key]) => [key, ""])) as Cargo;
export const STATUSES = [
  "awaiting_review",
  "trip_started",
  "picked_up",
  "in_transit",
  "arrived",
  "delivered",
  "cancelled",
] as const;
export type Status = (typeof STATUSES)[number];
export const LABELS: Record<Status, string> = {
  awaiting_review: "Awaiting review",
  trip_started: "Trip started",
  picked_up: "Cargo picked up",
  in_transit: "In transit",
  arrived: "Arrived at destination",
  delivered: "Delivered",
  cancelled: "Cancelled",
};
export type Milestone = { id: string; status: Status; at: number };
export type Shipment = {
  id: string;
  reference: string;
  customerId: string;
  cargo: Cargo;
  status: Status;
  createdAt: number;
  updatedAt: number;
  events: Milestone[];
};
export type Profile = { uid: string; phone: string; fullName: string };
export const isActive = (s: Shipment) =>
  s.status !== "delivered" && s.status !== "cancelled";
export function normalizePhone(input: string): string {
  let phone = input.replace(/[\s()-]/g, "");
  if (/^0[79]\d{8}$/.test(phone)) phone = "+251" + phone.slice(1);
  if (/^251[79]\d{8}$/.test(phone)) phone = "+" + phone;
  if (!/^\+[1-9]\d{7,14}$/.test(phone))
    throw new Error("Enter a valid phone number, for example +251912345678.");
  return phone;
}
export function validateCargo(value: unknown): Cargo {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid shipment details.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((k) => !FIELDS.some(([f]) => f === k)))
    throw new Error("Unexpected shipment field.");
  return Object.fromEntries(
    FIELDS.map(([key]) => {
      const v = input[key] ?? "";
      if (typeof v !== "string" || v.length > 2000)
        throw new Error("Each field must be text under 2,000 characters.");
      return [key, v.trim()];
    }),
  ) as Cargo;
}
