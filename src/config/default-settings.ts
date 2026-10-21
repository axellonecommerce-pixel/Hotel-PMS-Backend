export const DEFAULT_RESERVATION_SOURCES = [
  "Walk-In",
  "Phone Call",
  "OTA Reservation",
  "Stayover",
  "Other",
] as const;

export const DEFAULT_PAYMENT_TYPES = [
  "Cash",
  "Credit",
  "Direct Bill",
  "OYO Pay",
  "Hotel Pay Credit",
  "Hotel Pay Cash",
  "Other",
] as const;

export const DEFAULT_CHARGE_TYPES = [
  "Room Rent",
  "Pet Fee",
  "Early Check-In",
  "Late Checkout",
  "Miscellaneous Non-Taxable",
] as const;

export const DEFAULT_EXPENSE_CATEGORIES = [
  "Utilities",
  "Payroll",
  "Maintenance",
  "Supplies",
  "Laundry",
  "Office",
  "Repairs",
  "Taxes",
  "Insurance",
  "OTA Fees",
  "Other",
] as const;

export const DEFAULT_USER_ROLES = ["Owner/Admin", "Manager", "Front Desk", "Housekeeper"] as const;

export type BookingChannel = {
  id: string;
  name: string;
  type: "Direct" | "OTA" | "Company";
  commissionPercent: number;
  active: boolean;
};

export type AppSettings = {
  property: {
    name: string;
    addressLine1: string;
    city: string;
    state: string;
    postalCode: string;
    phone: string;
    roomCount: number;
    checkInTime: string;
    checkoutTime: string;
  };
  roomTypes: Array<{
    id: string;
    name: string;
    shortLabel: string;
    bedDescription: string;
    maxOccupancy: number;
    baseRateCents: number;
    active: boolean;
  }>;
  reservationSources: string[];
  bookingChannels: BookingChannel[];
  rateCodes: Array<{
    id: string;
    name: string;
    rateAdjustmentPercent: number;
    active: boolean;
  }>;
  paymentTypes: string[];
  chargeTypes: string[];
  expenseCategories: string[];
  userRoles: string[];
  payrollFrequencies: string[];
  payroll: {
    frequency: string;
    periodLabel: string;
    trackRoomsCleaned: boolean;
  };
  invoice: {
    prefix: string;
    numberFormat: string;
    nextInvoiceNumber: number;
    defaultDueDays: number;
  };
  tax: {
    percentage: number;
    label: string;
  };
  users: Array<{
    id: string;
    name: string;
    role: string;
    status: "Active" | "Inactive";
  }>;
};

export const defaultSettings: AppSettings = {
  property: {
    name: "New Property",
    addressLine1: "",
    city: "",
    state: "",
    postalCode: "",
    phone: "",
    roomCount: 0,
    checkInTime: "3:00 PM",
    checkoutTime: "11:00 AM",
  },
  roomTypes: [
    {
      id: "room-type-queen",
      name: "Standard Queen",
      shortLabel: "1 Queen",
      bedDescription: "One queen bed",
      maxOccupancy: 2,
      baseRateCents: 10900,
      active: true,
    },
    {
      id: "room-type-double",
      name: "Double Queen",
      shortLabel: "2 Queens",
      bedDescription: "Two queen beds",
      maxOccupancy: 4,
      baseRateCents: 11900,
      active: true,
    },
    {
      id: "room-type-king",
      name: "Standard King",
      shortLabel: "1 King",
      bedDescription: "One king bed",
      maxOccupancy: 2,
      baseRateCents: 11900,
      active: true,
    },
  ],
  reservationSources: [...DEFAULT_RESERVATION_SOURCES],
  bookingChannels: [
    { id: "walk-in", name: "Walk-In", type: "Direct", commissionPercent: 0, active: true },
    { id: "phone", name: "Phone Call", type: "Direct", commissionPercent: 0, active: true },
    { id: "website", name: "Motel Website", type: "Direct", commissionPercent: 0, active: true },
    { id: "booking-com", name: "Booking.com", type: "OTA", commissionPercent: 15, active: true },
    { id: "expedia", name: "Expedia", type: "OTA", commissionPercent: 18, active: true },
    { id: "agoda", name: "Agoda", type: "OTA", commissionPercent: 17, active: true },
    { id: "oyo", name: "OYO", type: "OTA", commissionPercent: 15, active: true },
    { id: "stayover", name: "Stayover", type: "Direct", commissionPercent: 0, active: true },
    { id: "company", name: "Company Direct Bill", type: "Company", commissionPercent: 0, active: true },
  ],
  rateCodes: [
    { id: "rack", name: "RACK", rateAdjustmentPercent: 0, active: true },
    { id: "walk-in", name: "WALK-IN", rateAdjustmentPercent: 0, active: true },
    { id: "fixed", name: "FIXED GUEST RATE", rateAdjustmentPercent: 0, active: true },
    { id: "company", name: "COMPANY RATE", rateAdjustmentPercent: -10, active: true },
  ],
  paymentTypes: [...DEFAULT_PAYMENT_TYPES],
  chargeTypes: [...DEFAULT_CHARGE_TYPES],
  expenseCategories: [...DEFAULT_EXPENSE_CATEGORIES],
  userRoles: [...DEFAULT_USER_ROLES],
  payrollFrequencies: ["Weekly", "Biweekly", "Semi-monthly"],
  payroll: {
    frequency: "Semi-monthly",
    periodLabel: "1st-15th and 16th-end of month",
    trackRoomsCleaned: true,
  },
  invoice: {
    prefix: "INV",
    numberFormat: "INV-YYYY-####",
    nextInvoiceNumber: 1,
    defaultDueDays: 30,
  },
  tax: {
    percentage: 10,
    label: "Transient Occupancy Tax",
  },
  users: [],
};

export function formatInvoiceNumber(
  year: number,
  sequence: number,
  invoiceSettings = defaultSettings.invoice,
) {
  const digitToken = invoiceSettings.numberFormat.match(/#+/)?.[0] ?? "####";
  return invoiceSettings.numberFormat
    .replace(/^[A-Za-z0-9]+/, invoiceSettings.prefix)
    .replace("YYYY", String(year))
    .replace(/#+/, String(Math.max(1, Math.floor(sequence))).padStart(digitToken.length, "0"));
}
