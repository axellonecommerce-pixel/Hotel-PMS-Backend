import type { Room, RoomType } from "@/domain/types/room";
import { defaultSettings } from "@/config/default-settings";
import { propertyRoomCodes } from "@/data/mock/property-layout";

export const mockRoomTypes: RoomType[] = defaultSettings.roomTypes.map((roomType) => ({
  ...roomType,
}));

const roomNumbers = Array.from(
  { length: defaultSettings.property.roomCount },
  (_, index) => String(101 + index),
);

const occupiedRooms = new Set([
  "101",
  "102",
  ...Array.from({ length: 17 }, (_, index) => String(105 + index)),
  "122",
  "123",
  "124",
  "126",
  "127",
  "128",
  "129",
  "132",
  "134",
]);

const dirtyRooms = new Set(["103", "125", "138", "139", "140"]);
const dueOutRooms = new Set(["107", "117", "129"]);
const smokingRooms = new Set(["134", "135", "136", "137", "138", "139", "140", "141", "142"]);

function roomTypeFor(number: string) {
  const code = propertyRoomCodes[number];
  if (code?.endsWith("1K")) return "room-type-king";
  if (code?.endsWith("2B")) return "room-type-double";
  return "room-type-queen";
}

export const mockRooms: Room[] = roomNumbers.map((number, index) => {
  const floor = 1;
  const isOutOfOrder = number === "142";
  const occupancyStatus = occupiedRooms.has(number) ? "occupied" : "vacant";
  const housekeepingStatus = dirtyRooms.has(number)
    ? "dirty"
    : number === "141"
      ? "cleaning"
      : isOutOfOrder
        ? "needs-attention"
        : "clean";

  return {
    id: `room-${number}`,
    number,
    floor,
    section: Number(number) <= 121 ? "West" : "East",
    mapOrder: index + 1,
    roomTypeId: roomTypeFor(number),
    serviceStatus: isOutOfOrder ? "out-of-order" : "in-service",
    housekeepingStatus,
    occupancyStatus,
    smokingAllowed: smokingRooms.has(number),
    isDueOut: dueOutRooms.has(number),
    outOfOrderReason: isOutOfOrder ? "Air conditioner service" : undefined,
  } satisfies Room;
});
