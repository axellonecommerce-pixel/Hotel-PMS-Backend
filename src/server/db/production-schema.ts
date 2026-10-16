import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = (name = "id") => uuid(name).primaryKey().defaultRandom();
const propertyId = () => uuid("property_id").notNull().references(() => properties.id);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const properties = pgTable("properties", {
  id: id(),
  name: text("name").notNull(),
  addressLine1: text("address_line_1").notNull(),
  city: text("city").notNull(),
  region: text("region").notNull(),
  postalCode: text("postal_code").notNull(),
  countryCode: text("country_code").notNull().default("US"),
  phone: text("phone").notNull(),
  email: text("email"),
  timezone: text("timezone").notNull(),
  currencyCode: text("currency_code").notNull().default("USD"),
  logoStorageKey: text("logo_storage_key"),
  status: text("status").notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const propertySettings = pgTable("property_settings", {
  id: id(),
  propertyId: propertyId(),
  key: text("key").notNull(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
}, (table) => [uniqueIndex("property_settings_property_key").on(table.propertyId, table.key)]);

export const propertyMemberships = pgTable("property_memberships", {
  id: id(),
  propertyId: propertyId(),
  authUserId: uuid("auth_user_id").notNull(),
  role: text("role").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  uniqueIndex("property_membership_user_property").on(table.authUserId, table.propertyId),
  index("property_membership_property_active").on(table.propertyId, table.active),
]);

export const employees = pgTable("employees", {
  id: id(),
  propertyId: propertyId(),
  membershipId: uuid("membership_id").references(() => propertyMemberships.id),
  name: text("name").notNull(),
  email: text("email"),
  jobRole: text("job_role").notNull(),
  payMethod: text("pay_method").notNull().default("hourly"),
  hourlyRateCents: integer("hourly_rate_cents"),
  fixedRateCents: integer("fixed_rate_cents"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [index("employees_property_active").on(table.propertyId, table.active)]);

export const roomTypes = pgTable("room_types", {
  id: id(),
  propertyId: propertyId(),
  name: text("name").notNull(),
  shortLabel: text("short_label").notNull(),
  maxOccupancy: integer("max_occupancy").notNull(),
  baseRateCents: integer("base_rate_cents").notNull(),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [uniqueIndex("room_types_property_name").on(table.propertyId, table.name)]);

export const rooms = pgTable("rooms", {
  id: id(),
  propertyId: propertyId(),
  roomTypeId: uuid("room_type_id").notNull().references(() => roomTypes.id),
  number: text("number").notNull(),
  floor: text("floor").notNull(),
  section: text("section"),
  cleanlinessStatus: text("cleanliness_status").notNull().default("clean"),
  serviceStatus: text("service_status").notNull().default("rentable"),
  smokingAllowed: boolean("smoking_allowed").notNull().default(false),
  active: boolean("active").notNull().default(true),
  mapData: jsonb("map_data"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  uniqueIndex("rooms_property_number").on(table.propertyId, table.number),
  index("rooms_property_status").on(table.propertyId, table.serviceStatus, table.cleanlinessStatus),
]);

export const guests = pgTable("guests", {
  id: id(),
  propertyId: propertyId(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  phone: text("phone"),
  email: text("email"),
  address: jsonb("address"),
  guestStatus: text("guest_status").notNull().default("active"),
  remarks: text("remarks"),
  dnrReason: text("dnr_reason"),
  roomPreferences: jsonb("room_preferences"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [index("guests_property_name").on(table.propertyId, table.lastName, table.firstName)]);

export const guestRemarks = pgTable("guest_remarks", {
  id: id(),
  propertyId: propertyId(),
  guestId: uuid("guest_id").notNull().references(() => guests.id),
  remark: text("remark").notNull(),
  createdAt: createdAt(),
}, (table) => [index("guest_remarks_guest_date").on(table.guestId, table.createdAt)]);

export const guestIdentities = pgTable("guest_identities", {
  id: id(),
  propertyId: propertyId(),
  guestId: uuid("guest_id").notNull().references(() => guests.id),
  idType: text("id_type").notNull(),
  idNumber: text("id_number").notNull(),
  normalizedIdNumber: text("normalized_id_number").notNull(),
  storageKey: text("storage_key"),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  deleteAfter: timestamp("delete_after", { withTimezone: true }).notNull(),
  warnedAt: timestamp("warned_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("guest_identity_property_number").on(table.propertyId, table.idType, table.normalizedIdNumber),
  index("guest_identity_retention").on(table.propertyId, table.deleteAfter, table.deletedAt),
]);

export const guestPaymentSources = pgTable("guest_payment_sources", {
  id: id(),
  propertyId: propertyId(),
  guestId: uuid("guest_id").notNull().references(() => guests.id),
  method: text("method").notNull(),
  label: text("label"),
  last4: text("last4"),
  externalReference: text("external_reference"),
  createdAt: createdAt(),
}, (table) => [index("guest_payment_source_guest").on(table.guestId)]);

export const guestVehicles = pgTable("guest_vehicles", {
  id: id(),
  propertyId: propertyId(),
  guestId: uuid("guest_id").notNull().references(() => guests.id),
  plate: text("plate").notNull(),
  make: text("make"),
  color: text("color"),
  year: text("year"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [index("guest_vehicle_guest").on(table.guestId)]);

export const companies = pgTable("companies", {
  id: id(),
  propertyId: propertyId(),
  name: text("name").notNull(),
  billingAddress: jsonb("billing_address").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [uniqueIndex("companies_property_name").on(table.propertyId, table.name)]);

export const companyContacts = pgTable("company_contacts", {
  id: id(),
  propertyId: propertyId(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  primary: boolean("primary").notNull().default(false),
});

export const companyRoomRates = pgTable("company_room_rates", {
  id: id(),
  propertyId: propertyId(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  roomTypeId: uuid("room_type_id").notNull().references(() => roomTypes.id),
  rateCents: integer("rate_cents").notNull(),
}, (table) => [uniqueIndex("company_room_rate_unique").on(table.companyId, table.roomTypeId)]);

export const bookingSources = pgTable("booking_sources", {
  id: id(),
  propertyId: propertyId(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  commissionBasisPoints: integer("commission_basis_points").notNull().default(0),
  active: boolean("active").notNull().default(true),
}, (table) => [uniqueIndex("booking_sources_property_name").on(table.propertyId, table.name)]);

export const promotions = pgTable("promotions", {
  id: id(),
  propertyId: propertyId(),
  name: text("name").notNull(),
  discountType: text("discount_type").notNull(),
  discountValue: integer("discount_value").notNull(),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on").notNull(),
  active: boolean("active").notNull().default(true),
});

export const promotionRoomTypes = pgTable("promotion_room_types", {
  id: id(),
  propertyId: propertyId(),
  promotionId: uuid("promotion_id").notNull().references(() => promotions.id),
  roomTypeId: uuid("room_type_id").notNull().references(() => roomTypes.id),
}, (table) => [uniqueIndex("promotion_room_type_unique").on(table.promotionId, table.roomTypeId)]);

export const taxDefinitions = pgTable("tax_definitions", {
  id: id(),
  propertyId: propertyId(),
  name: text("name").notNull(),
  rateBasisPoints: integer("rate_basis_points").notNull(),
  appliesToRoomRent: boolean("applies_to_room_rent").notNull().default(true),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [uniqueIndex("tax_definition_property_name").on(table.propertyId, table.name)]);

export const chargeTypes = pgTable("charge_types", {
  id: id(),
  propertyId: propertyId(),
  name: text("name").notNull(),
  revenueCategory: text("revenue_category").notNull(),
  taxable: boolean("taxable").notNull().default(false),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [uniqueIndex("charge_type_property_name").on(table.propertyId, table.name)]);

export const registrationRuleVersions = pgTable("registration_rule_versions", {
  id: id(),
  propertyId: propertyId(),
  versionNumber: integer("version_number").notNull(),
  content: text("content").notNull(),
  active: boolean("active").notNull().default(true),
  createdByEmployeeId: uuid("created_by_employee_id").references(() => employees.id),
  createdAt: createdAt(),
}, (table) => [uniqueIndex("registration_rules_property_version").on(table.propertyId, table.versionNumber)]);

export const reservations = pgTable("reservations", {
  id: id(),
  propertyId: propertyId(),
  mainGuestId: uuid("main_guest_id").notNull().references(() => guests.id),
  companyId: uuid("company_id").references(() => companies.id),
  confirmationNumber: text("confirmation_number").notNull(),
  bookingSourceId: uuid("booking_source_id").references(() => bookingSources.id),
  status: text("status").notNull(),
  arrivalDate: date("arrival_date").notNull(),
  departureDate: date("departure_date").notNull(),
  groupReservation: boolean("group_reservation").notNull().default(false),
  otaPaymentStatus: text("ota_payment_status"),
  taxRateBasisPoints: integer("tax_rate_basis_points").notNull(),
  taxExempt: boolean("tax_exempt").notNull().default(false),
  taxExemptionReference: text("tax_exemption_reference"),
  currencyCode: text("currency_code").notNull(),
  notes: text("notes"),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  uniqueIndex("reservations_property_confirmation").on(table.propertyId, table.confirmationNumber),
  index("reservations_property_dates").on(table.propertyId, table.arrivalDate, table.departureDate),
]);

export const reservationRooms = pgTable("reservation_rooms", {
  id: id(),
  propertyId: propertyId(),
  reservationId: uuid("reservation_id").notNull().references(() => reservations.id),
  roomTypeId: uuid("room_type_id").notNull().references(() => roomTypes.id),
  roomId: uuid("room_id").references(() => rooms.id),
  status: text("status").notNull(),
  checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
  checkedOutAt: timestamp("checked_out_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [index("reservation_rooms_room_status").on(table.roomId, table.status)]);

export const reservationGuests = pgTable("reservation_guests", {
  id: id(),
  propertyId: propertyId(),
  reservationId: uuid("reservation_id").notNull().references(() => reservations.id),
  reservationRoomId: uuid("reservation_room_id").references(() => reservationRooms.id),
  guestId: uuid("guest_id").notNull().references(() => guests.id),
  primary: boolean("primary").notNull().default(false),
}, (table) => [uniqueIndex("reservation_guest_unique").on(table.reservationId, table.guestId)]);

export const dnrOverrides = pgTable("dnr_overrides", {
  id: id(),
  propertyId: propertyId(),
  reservationId: uuid("reservation_id").notNull().references(() => reservations.id),
  guestId: uuid("guest_id").notNull().references(() => guests.id),
  reason: text("reason").notNull(),
  overriddenByEmployeeId: uuid("overridden_by_employee_id").references(() => employees.id),
  createdAt: createdAt(),
});

export const registrationAcceptances = pgTable("registration_acceptances", {
  id: id(),
  propertyId: propertyId(),
  reservationId: uuid("reservation_id").notNull().references(() => reservations.id),
  ruleVersionId: uuid("rule_version_id").notNull().references(() => registrationRuleVersions.id),
  acceptedRuleContent: text("accepted_rule_content").notNull(),
  signatureStorageKey: text("signature_storage_key"),
  signedByGuestId: uuid("signed_by_guest_id").references(() => guests.id),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
});

export const nightlyRates = pgTable("nightly_rates", {
  id: id(),
  propertyId: propertyId(),
  reservationRoomId: uuid("reservation_room_id").notNull().references(() => reservationRooms.id),
  stayDate: date("stay_date").notNull(),
  baseRateCents: integer("base_rate_cents").notNull(),
  discountCents: integer("discount_cents").notNull().default(0),
  finalRateCents: integer("final_rate_cents").notNull(),
}, (table) => [uniqueIndex("nightly_rate_room_date").on(table.reservationRoomId, table.stayDate)]);

export const reservationPromotions = pgTable("reservation_promotions", {
  id: id(),
  propertyId: propertyId(),
  reservationId: uuid("reservation_id").notNull().references(() => reservations.id),
  promotionId: uuid("promotion_id").notNull().references(() => promotions.id),
  appliedOrder: integer("applied_order").notNull(),
}, (table) => [uniqueIndex("reservation_promotion_unique").on(table.reservationId, table.promotionId)]);

export const roomMoves = pgTable("room_moves", {
  id: id(),
  propertyId: propertyId(),
  reservationRoomId: uuid("reservation_room_id").notNull().references(() => reservationRooms.id),
  fromRoomId: uuid("from_room_id").notNull().references(() => rooms.id),
  toRoomId: uuid("to_room_id").notNull().references(() => rooms.id),
  rateDecision: text("rate_decision").notNull(),
  remark: text("remark").notNull(),
  movedByEmployeeId: uuid("moved_by_employee_id").references(() => employees.id),
  movedAt: timestamp("moved_at", { withTimezone: true }).notNull().defaultNow(),
});

export const documentSequences = pgTable("document_sequences", {
  id: id(),
  propertyId: propertyId(),
  prefix: text("prefix").notNull(),
  format: text("format").notNull(),
  nextNumber: integer("next_number").notNull().default(1),
  resetYearly: boolean("reset_yearly").notNull().default(true),
  currentYear: integer("current_year").notNull(),
}, (table) => [uniqueIndex("document_sequence_property").on(table.propertyId)]);

export const folios = pgTable("folios", {
  id: id(),
  propertyId: propertyId(),
  reservationId: uuid("reservation_id").notNull().references(() => reservations.id),
  reservationRoomId: uuid("reservation_room_id").references(() => reservationRooms.id),
  number: text("number").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("open"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [uniqueIndex("folios_property_number").on(table.propertyId, table.number)]);

export const charges = pgTable("charges", {
  id: id(),
  propertyId: propertyId(),
  folioId: uuid("folio_id").notNull().references(() => folios.id),
  reservationRoomId: uuid("reservation_room_id").references(() => reservationRooms.id),
  linkedChargeId: uuid("linked_charge_id"),
  type: text("type").notNull(),
  description: text("description").notNull(),
  serviceDate: date("service_date").notNull(),
  amountCents: integer("amount_cents").notNull(),
  taxable: boolean("taxable").notNull().default(false),
  status: text("status").notNull().default("posted"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [index("charges_folio_date").on(table.folioId, table.serviceDate)]);

export const chargeTaxes = pgTable("charge_taxes", {
  id: id(),
  propertyId: propertyId(),
  chargeId: uuid("charge_id").notNull().references(() => charges.id),
  name: text("name").notNull(),
  rateBasisPoints: integer("rate_basis_points").notNull(),
  amountCents: integer("amount_cents").notNull(),
  overrideReason: text("override_reason"),
}, (table) => [uniqueIndex("charge_tax_charge").on(table.chargeId)]);

export const payments = pgTable("payments", {
  id: id(),
  propertyId: propertyId(),
  reservationId: uuid("reservation_id").references(() => reservations.id),
  companyId: uuid("company_id").references(() => companies.id),
  method: text("method").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currencyCode: text("currency_code").notNull(),
  effectiveDate: date("effective_date").notNull(),
  cardType: text("card_type"),
  last4: text("last4"),
  externalReference: text("external_reference"),
  note: text("note"),
  createdAt: createdAt(),
});

export const paymentAllocations = pgTable("payment_allocations", {
  id: id(),
  propertyId: propertyId(),
  paymentId: uuid("payment_id").notNull().references(() => payments.id),
  folioId: uuid("folio_id").notNull().references(() => folios.id),
  amountCents: integer("amount_cents").notNull(),
  createdAt: createdAt(),
});

export const refunds = pgTable("refunds", {
  id: id(),
  propertyId: propertyId(),
  paymentId: uuid("payment_id").notNull().references(() => payments.id),
  amountCents: integer("amount_cents").notNull(),
  effectiveDate: date("effective_date").notNull(),
  reason: text("reason"),
  createdAt: createdAt(),
});

export const securityDeposits = pgTable("security_deposits", {
  id: id(),
  propertyId: propertyId(),
  reservationRoomId: uuid("reservation_room_id").notNull().references(() => reservationRooms.id),
  method: text("method").notNull(),
  amountCents: integer("amount_cents").notNull(),
  status: text("status").notNull(),
  showOnFolio: boolean("show_on_folio").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const depositTransactions = pgTable("deposit_transactions", {
  id: id(),
  propertyId: propertyId(),
  depositId: uuid("deposit_id").notNull().references(() => securityDeposits.id),
  type: text("type").notNull(),
  amountCents: integer("amount_cents").notNull(),
  reason: text("reason"),
  note: text("note"),
  createdAt: createdAt(),
});

export const invoices = pgTable("invoices", {
  id: id(),
  propertyId: propertyId(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  reservationId: uuid("reservation_id").notNull().references(() => reservations.id),
  number: text("number").notNull(),
  status: text("status").notNull().default("draft"),
  dueDate: date("due_date").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [uniqueIndex("invoices_property_number").on(table.propertyId, table.number)]);

export const invoiceLines = pgTable("invoice_lines", {
  id: id(),
  propertyId: propertyId(),
  invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
  folioId: uuid("folio_id").references(() => folios.id),
  chargeId: uuid("charge_id").references(() => charges.id),
  description: text("description").notNull(),
  amountCents: integer("amount_cents").notNull(),
});

export const invoicePaymentAllocations = pgTable("invoice_payment_allocations", {
  id: id(),
  propertyId: propertyId(),
  paymentId: uuid("payment_id").notNull().references(() => payments.id),
  invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
  amountCents: integer("amount_cents").notNull(),
  createdAt: createdAt(),
});

export const companyCredits = pgTable("company_credits", {
  id: id(),
  propertyId: propertyId(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  sourcePaymentId: uuid("source_payment_id").notNull().references(() => payments.id),
  originalAmountCents: integer("original_amount_cents").notNull(),
  remainingAmountCents: integer("remaining_amount_cents").notNull(),
  createdAt: createdAt(),
});

export const businessDays = pgTable("business_days", {
  id: id(),
  propertyId: propertyId(),
  businessDate: date("business_date").notNull(),
  status: text("status").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (table) => [uniqueIndex("business_days_property_date").on(table.propertyId, table.businessDate)]);

export const cashShifts = pgTable("cash_shifts", {
  id: id(),
  propertyId: propertyId(),
  businessDayId: uuid("business_day_id").notNull().references(() => businessDays.id),
  employeeId: uuid("employee_id").notNull().references(() => employees.id),
  openingCents: integer("opening_cents").notNull(),
  expectedCents: integer("expected_cents"),
  countedCents: integer("counted_cents"),
  drawerFloatCents: integer("drawer_float_cents").notNull(),
  status: text("status").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const cashDrops = pgTable("cash_drops", {
  id: id(),
  propertyId: propertyId(),
  cashShiftId: uuid("cash_shift_id").notNull().references(() => cashShifts.id),
  amountCents: integer("amount_cents").notNull(),
  note: text("note"),
  createdAt: createdAt(),
});

export const cashShiftTransactions = pgTable("cash_shift_transactions", {
  id: id(),
  propertyId: propertyId(),
  cashShiftId: uuid("cash_shift_id").notNull().references(() => cashShifts.id),
  type: text("type").notNull(),
  amountCents: integer("amount_cents").notNull(),
  sourceType: text("source_type"),
  sourceId: uuid("source_id"),
  note: text("note"),
  createdAt: createdAt(),
}, (table) => [index("cash_shift_transactions_shift").on(table.cashShiftId, table.createdAt)]);

export const housekeepingRecords = pgTable("housekeeping_records", {
  id: id(),
  propertyId: propertyId(),
  roomId: uuid("room_id").notNull().references(() => rooms.id),
  housekeeperEmployeeId: uuid("housekeeper_employee_id").references(() => employees.id),
  serviceDate: date("service_date").notNull(),
  serviceType: text("service_type").notNull(),
  cleanlinessStatus: text("cleanliness_status").notNull(),
  assignmentStatus: text("assignment_status").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [uniqueIndex("housekeeping_room_date").on(table.roomId, table.serviceDate)]);

export const maintenanceOrders = pgTable("maintenance_orders", {
  id: id(),
  propertyId: propertyId(),
  roomId: uuid("room_id").notNull().references(() => rooms.id),
  problem: text("problem").notNull(),
  priority: text("priority").notNull(),
  assignedWorker: text("assigned_worker"),
  costCents: integer("cost_cents").notNull().default(0),
  rentable: boolean("rentable").notNull(),
  status: text("status").notNull(),
  notes: text("notes"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  returnedToServiceAt: timestamp("returned_to_service_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const timeEntries = pgTable("time_entries", {
  id: id(),
  propertyId: propertyId(),
  employeeId: uuid("employee_id").notNull().references(() => employees.id),
  workDate: date("work_date").notNull(),
  clockInAt: timestamp("clock_in_at", { withTimezone: true }).notNull(),
  clockOutAt: timestamp("clock_out_at", { withTimezone: true }),
  lunchTaken: boolean("lunch_taken").notNull().default(false),
  breakMinutes: integer("break_minutes").notNull().default(0),
  correctionNote: text("correction_note"),
}, (table) => [uniqueIndex("time_entries_employee_date").on(table.employeeId, table.workDate)]);

export const payPeriods = pgTable("pay_periods", {
  id: id(),
  propertyId: propertyId(),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on").notNull(),
  scheduledPayDate: date("scheduled_pay_date").notNull(),
  status: text("status").notNull().default("open"),
  createdAt: createdAt(),
}, (table) => [uniqueIndex("pay_period_property_dates").on(table.propertyId, table.startsOn, table.endsOn)]);

export const payrollEntries = pgTable("payroll_entries", {
  id: id(),
  propertyId: propertyId(),
  payPeriodId: uuid("pay_period_id").notNull().references(() => payPeriods.id),
  employeeId: uuid("employee_id").notNull().references(() => employees.id),
  calculationType: text("calculation_type").notNull(),
  regularMinutes: integer("regular_minutes").notNull().default(0),
  overtimeMinutes: integer("overtime_minutes").notNull().default(0),
  quantity: integer("quantity"),
  rateCents: integer("rate_cents"),
  description: text("description"),
  grossPayCents: integer("gross_pay_cents").notNull(),
  paid: boolean("paid").notNull().default(false),
  paidOn: date("paid_on"),
  paymentMethod: text("payment_method"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [uniqueIndex("payroll_entry_period_employee").on(table.payPeriodId, table.employeeId)]);

export const vendors = pgTable("vendors", {
  id: id(),
  propertyId: propertyId(),
  name: text("name").notNull(),
  contact: jsonb("contact"),
  active: boolean("active").notNull().default(true),
}, (table) => [uniqueIndex("vendors_property_name").on(table.propertyId, table.name)]);

export const expenses = pgTable("expenses", {
  id: id(),
  propertyId: propertyId(),
  vendorId: uuid("vendor_id").references(() => vendors.id),
  expenseDate: date("expense_date").notNull(),
  category: text("category").notNull(),
  description: text("description").notNull(),
  paymentMethod: text("payment_method").notNull(),
  amountCents: integer("amount_cents").notNull(),
  receiptStorageKey: text("receipt_storage_key"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const recurringExpenses = pgTable("recurring_expenses", {
  id: id(),
  propertyId: propertyId(),
  vendorId: uuid("vendor_id").references(() => vendors.id),
  category: text("category").notNull(),
  description: text("description").notNull(),
  paymentMethod: text("payment_method").notNull(),
  amountCents: integer("amount_cents").notNull(),
  frequency: text("frequency").notNull(),
  nextRunOn: date("next_run_on").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const nightAuditRuns = pgTable("night_audit_runs", {
  id: id(),
  propertyId: propertyId(),
  businessDayId: uuid("business_day_id").notNull().references(() => businessDays.id),
  trigger: text("trigger").notNull(),
  status: text("status").notNull(),
  blockingIssues: jsonb("blocking_issues").notNull().default([]),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  initiatedByEmployeeId: uuid("initiated_by_employee_id").references(() => employees.id),
});

export const reportDefinitions = pgTable("report_definitions", {
  id: id(),
  propertyId: propertyId(),
  name: text("name").notNull(),
  reportType: text("report_type").notNull(),
  selectedColumns: jsonb("selected_columns").notNull(),
  filters: jsonb("filters").notNull().default({}),
  createdByEmployeeId: uuid("created_by_employee_id").references(() => employees.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [uniqueIndex("report_definition_property_name").on(table.propertyId, table.name)]);

export const guestImportJobs = pgTable("guest_import_jobs", {
  id: id(),
  propertyId: propertyId(),
  status: text("status").notNull(),
  sourceFilename: text("source_filename").notNull(),
  totalRows: integer("total_rows").notNull().default(0),
  importedRows: integer("imported_rows").notNull().default(0),
  rejectedRows: integer("rejected_rows").notNull().default(0),
  errors: jsonb("errors").notNull().default([]),
  createdByEmployeeId: uuid("created_by_employee_id").references(() => employees.id),
  createdAt: createdAt(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const backupJobs = pgTable("backup_jobs", {
  id: id(),
  propertyId: propertyId(),
  type: text("type").notNull(),
  status: text("status").notNull(),
  storageKey: text("storage_key"),
  schemaVersion: text("schema_version").notNull(),
  manifest: jsonb("manifest"),
  failureReason: text("failure_reason"),
  createdByEmployeeId: uuid("created_by_employee_id").references(() => employees.id),
  createdAt: createdAt(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const retentionTombstones = pgTable("retention_tombstones", {
  id: id(),
  propertyId: propertyId(),
  resourceType: text("resource_type").notNull(),
  resourceId: uuid("resource_id").notNull(),
  storageKeyHash: text("storage_key_hash").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("retention_tombstone_resource").on(table.propertyId, table.resourceType, table.resourceId)]);

export const notifications = pgTable("notifications", {
  id: id(),
  propertyId: propertyId(),
  recipientMembershipId: uuid("recipient_membership_id").references(() => propertyMemberships.id),
  recipientRole: text("recipient_role"),
  type: text("type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  resourceType: text("resource_type"),
  resourceId: uuid("resource_id"),
  readAt: timestamp("read_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => [index("notifications_property_unresolved").on(table.propertyId, table.resolvedAt)]);

export const attachments = pgTable("attachments", {
  id: id(),
  propertyId: propertyId(),
  resourceType: text("resource_type").notNull(),
  resourceId: uuid("resource_id").notNull(),
  storageKey: text("storage_key").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: createdAt(),
}, (table) => [index("attachments_resource").on(table.propertyId, table.resourceType, table.resourceId)]);
