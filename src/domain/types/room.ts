export type RoomServiceStatus = "in-service" | "out-of-order";
export type HousekeepingStatus = "clean" | "dirty" | "cleaning" | "needs-attention";
export type OccupancyStatus = "vacant" | "occupied";

export type RoomType = {
  id: string;
  name: string;
  shortLabel: string;
  bedDescription: string;
  maxOccupancy: number;
  baseRateCents: number;
  active: boolean;
};

export type Room = {
  id: string;
  number: string;
  floor: 1 | 2;
  section: "West" | "East";
  mapOrder: number;
  roomTypeId: string;
  serviceStatus: RoomServiceStatus;
  housekeepingStatus: HousekeepingStatus;
  occupancyStatus: OccupancyStatus;
  smokingAllowed: boolean;
  isDueOut: boolean;
  outOfOrderReason?: string;
};
