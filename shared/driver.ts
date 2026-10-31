import type { Cargo, Milestone, Status } from "./contracts";
export type DriverProfile = {
  uid: string;
  fullName: string;
  phone: string;
  enabled: boolean;
  truckId: string;
  truckPlate: string;
  truckType: string;
  capacity: string;
  online: boolean;
  activeTripId: string | null;
};
export type DriverTrip = {
  id: string;
  reference: string;
  driverId: string;
  truckId: string;
  cargo: Cargo;
  status: Status;
  createdAt: number;
  updatedAt: number;
  events: Milestone[];
};
export type Fix = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  recordedAt: number;
};
export const NEXT: Partial<Record<Status, Status>> = {
  trip_started: "picked_up",
  picked_up: "in_transit",
  in_transit: "arrived",
  arrived: "delivered",
};
export const ACTIONS: Partial<Record<Status, string>> = {
  trip_started: "Confirm cargo pickup",
  picked_up: "Start transit",
  in_transit: "Arrived at destination",
  arrived: "Delivered",
};
export function canGoOffline(p: Pick<DriverProfile, "activeTripId">) {
  return !p.activeTripId;
}
export function assertMilestone(current: Status, next: Status) {
  if (NEXT[current] !== next)
    throw Error("This milestone is no longer the next step. Refresh the trip.");
}
export function validateFix(f: Fix, now = Date.now()) {
  if (
    !f ||
    !Number.isFinite(f.latitude) ||
    !Number.isFinite(f.longitude) ||
    Math.abs(f.latitude) > 90 ||
    Math.abs(f.longitude) > 180 ||
    !Number.isFinite(f.recordedAt) ||
    f.recordedAt > now + 60000 ||
    f.recordedAt < now - 300000 ||
    (f.accuracy !== null && (!Number.isFinite(f.accuracy) || f.accuracy < 0))
  )
    throw Error("Location is invalid or too old. Obtain a new GPS fix.");
  return {
    latitude: f.latitude,
    longitude: f.longitude,
    accuracy: f.accuracy,
    recordedAt: f.recordedAt,
  };
}
