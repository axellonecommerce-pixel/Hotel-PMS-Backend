import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const id = (name: string) => text(name).primaryKey();
const createdAt = () => text("created_at").notNull();
const updatedAt = () => text("updated_at").notNull();

export const properties = sqliteTable("properties", {
  id: id("id"),
  name: text("name").notNull(),
  addressLine1: text("address_line_1").notNull(),
  city: text("city").notNull(),
  state: text("state").notNull(),
  postalCode: text("postal_code").notNull(),
  phone: text("phone").notNull(),
  timezone: text("timezone").notNull(),
  roomCount: integer("room_count").notNull(),
  checkInTime: text("check_in_time").notNull(),
  checkoutTime: text("checkout_time").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const propertyMemberships = sqliteTable(
  "property_memberships",
  {
    id: id("id"),
    propertyId: text("property_id").notNull().references(() => properties.id),
    authUserId: text("auth_user_id").notNull(),
    role: text("role").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("property_memberships_user_property_key").on(table.authUserId, table.propertyId),
    index("property_memberships_user_active_idx").on(table.authUserId, table.active),
  ],
);

export const propertySettings = sqliteTable(
  "property_settings",
  {
    id: id("id"),
    propertyId: text("property_id").notNull().references(() => properties.id),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("property_settings_property_key").on(table.propertyId, table.key)],
);

export const roomTypes = sqliteTable(
  "room_types",
  {
    id: id("id"),
    propertyId: text("property_id").notNull().references(() => properties.id),
    name: text("name").notNull(),
    shortLabel: text("short_label").notNull(),
    bedDescription: text("bed_description").notNull(),
    maxOccupancy: integer("max_occupancy").notNull(),
    baseRateCents: integer("base_rate_cents").notNull(),
    active: integer("active", { mode: "boolean" }).notNull(),
    sortOrder: integer("sort_order").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("room_types_property_idx").on(table.propertyId)],
);

export const rooms = sqliteTable(
  "rooms",
  {
    id: id("id"),
    propertyId: text("property_id").notNull().references(() => properties.id),
    roomTypeId: text("room_type_id").notNull().references(() => roomTypes.id),
    number: text("number").notNull(),
    floor: integer("floor").notNull(),
    section: text("section").notNull(),
    mapOrder: integer("map_order").notNull(),
    serviceStatus: text("service_status").notNull(),
    housekeepingStatus: text("housekeeping_status").notNull(),
    smokingAllowed: integer("smoking_allowed", { mode: "boolean" }).notNull().default(false),
    outOfOrderReason: text("out_of_order_reason"),
    active: integer("active", { mode: "boolean" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("rooms_property_number_key").on(table.propertyId, table.number),
    index("rooms_property_status_idx").on(table.propertyId, table.serviceStatus, table.housekeepingStatus),
  ],
);

export const guests = sqliteTable(
  "guests",
  {
    id: id("id"),
    propertyId: text("property_id").notNull().references(() => properties.id),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    phone: text("phone").notNull(),
    phoneNormalized: text("phone_normalized").notNull(),
    idType: text("id_type"),
    driverLicenseNumber: text("driver_license_number"),
    driverLicenseNormalized: text("driver_license_normalized"),
    dateOfBirth: text("date_of_birth"),
    idExpires: text("id_expires"),
    addressLine1: text("address_line_1"),
    postalCode: text("postal_code"),
    state: text("state"),
    country: text("country"),
    countryCode: text("country_code"),
    secondaryPhone: text("secondary_phone"),
    secondaryEmail: text("secondary_email"),
    city: text("city"),
    email: text("email"),
    guestStatus: text("guest_status").notNull(),
    preferredRateCents: integer("preferred_rate_cents"),
    notes: text("notes"),
    dnrCode: text("dnr_code"),
    dnrRemarks: text("dnr_remarks"),
    roomPreferences: text("room_preferences"),
    archivedAt: text("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("guests_property_phone_idx").on(table.propertyId, table.phoneNormalized),
    index("guests_property_name_idx").on(table.propertyId, table.lastName, table.firstName),
    uniqueIndex("guests_property_license_key").on(table.propertyId, table.driverLicenseNormalized),
  ],
);

export const guestRemarks = sqliteTable(
  "guest_remarks",
  {
    id: id("id"),
    propertyId: text("property_id").notNull().references(() => properties.id),
    guestId: text("guest_id").notNull().references(() => guests.id),
    remark: text("remark").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("guest_remarks_guest_date_idx").on(table.guestId, table.createdAt)],
);

export const companies = sqliteTable(
  "companies",
  {
    id: id("id"),
    propertyId: text("property_id").notNull().references(() => properties.id),
    name: text("name").notNull(),
    contactPerson: text("contact_person").notNull(),
    phone: text("phone").notNull(),
    email: text("email").notNull(),
    billingAddress: text("billing_address").notNull(),
    status: text("status").notNull(),
    paymentTermsDays: integer("payment_terms_days").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("companies_property_status_idx").on(table.propertyId, table.status)],
);

export const bookingChannels = sqliteTable(
  "booking_channels",
  {
    id: id("id"),
    propertyId: text("property_id").notNull().references(() => properties.id),
    name: text("name").notNull(),
    channelType: text("channel_type").notNull(),
    commissionBasisPoints: integer("commission_basis_points").notNull(),
    active: integer("active", { mode: "boolean" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("booking_channels_property_name_key").on(table.propertyId, table.name),
    index("booking_channels_property_active_idx").on(table.propertyId, table.active),
  ],
);

export const businessDays = sqliteTable(
  "business_days",
  {
    id: id("id"),
    propertyId: text("property_id").notNull().references(() => properties.id),
    businessDate: text("business_date").notNull(),
    status: text("status").notNull(),
    openedAt: text("opened_at").notNull(),
    closedAt: text("closed_at"),
    closedByEmployeeId: text("closed_by_employee_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("business_days_property_date_key").on(table.propertyId, table.businessDate)],
);

export const employees = sqliteTable(
  "employees",
  {
    id: id("id"),
    propertyId: text("property_id").notNull().references(() => properties.id),
    membershipId: text("membership_id").references(() => propertyMemberships.id),
    name: text("name").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull(),
    hourlyRateCents: integer("hourly_rate_cents").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("employees_property_status_idx").on(table.propertyId, table.status)],
);

export const reservations = sqliteTable(
  "reservations",
  {
    id: id("id"),
    propertyId: text("property_id").notNull().references(() => properties.id),
    guestId: text("guest_id").notNull().references(() => guests.id),
    roomId: text("room_id").references(() => rooms.id),
    roomTypeId: text("room_type_id").references(() => roomTypes.id),
    companyId: text("company_id").references(() => companies.id),
    confirmationNumber: text("confirmation_number").notNull(),
    source: text("source").notNull(),
    status: text("status").notNull(),
    arrivalDate: text("arrival_date").notNull(),
    departureDate: text("departure_date").notNull(),
    adultCount: integer("adult_count").notNull(),
    childCount: integer("child_count").notNull(),
    roomRateCents: integer("room_rate_cents").notNull(),
    nightlyRatesJson: text("nightly_rates_json").notNull().default("[]"),
    promotionIdsJson: text("promotion_ids_json").notNull().default("[]"),
    taxRateBasisPoints: integer("tax_rate_basis_points").notNull().default(1000),
    taxExempt: integer("tax_exempt", { mode: "boolean" }).notNull().default(false),
    taxExemptionReason: text("tax_exemption_reason"),
    taxExemptionCertificate: text("tax_exemption_certificate"),
    otaPaymentStatus: text("ota_payment_status"),
    paymentArrangement: text("payment_arrangement").notNull(),
    rateCode: text("rate_code"),
    petCount: integer("pet_count").notNull().default(0),
    servicePetCount: integer("service_pet_count").notNull().default(0),
    bookingRemarks: text("booking_remarks"),
    stayRemarks: text("stay_remarks"),
    housekeepingRemarks: text("housekeeping_remarks"),
    otherRemarks: text("other_remarks"),
    notes: text("notes"),
    checkedInAt: text("checked_in_at"),
    checkedOutAt: text("checked_out_at"),
    createdByEmployeeId: text("created_by_employee_id").references(() => employees.id),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("reservations_property_dates_idx").on(table.propertyId, table.arrivalDate, table.departureDate),
    index("reservations_room_dates_idx").on(table.roomId, table.arrivalDate, table.departureDate),
    index("reservations_guest_idx").on(table.guestId),
    index("reservations_status_idx").on(table.status),
  ],
);

export const reservationRooms = sqliteTable(
  "reservation_rooms",
  {
    id: id("id"),
    propertyId: text("property_id").notNull().references(() => properties.id),
    reservationId: text("reservation_id").notNull().references(() => reservations.id),
    roomTypeId: text("room_type_id").notNull().references(() => roomTypes.id),
    roomId: text("room_id").references(() => rooms.id),
    status: text("status").notNull(),
    checkedInAt: text("checked_in_at"),
    checkedOutAt: text("checked_out_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("reservation_rooms_reservation_idx").on(table.reservationId),
    index("reservation_rooms_room_status_idx").on(table.roomId, table.status),
  ],
);

export const guestVehicles = sqliteTable(
  "guest_vehicles",
  {
    id: id("id"),
    guestId: text("guest_id").notNull().references(() => guests.id),
    plate: text("plate").notNull(),
    make: text("make"),
    color: text("color"),
    year: text("year"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("guest_vehicles_guest_idx").on(table.guestId)],
);

export const roomMoves = sqliteTable(
  "room_moves",
  {
    id: id("id"),
    propertyId: text("property_id").notNull().references(() => properties.id),
    reservationRoomId: text("reservation_room_id").notNull().references(() => reservationRooms.id),
    fromRoomId: text("from_room_id").notNull().references(() => rooms.id),
    toRoomId: text("to_room_id").notNull().references(() => rooms.id),
    rateDecision: text("rate_decision").notNull(),
    remark: text("remark").notNull(),
    movedByEmployeeId: text("moved_by_employee_id").references(() => employees.id),
    movedAt: text("moved_at").notNull(),
  },
  (table) => [index("room_moves_reservation_room_idx").on(table.reservationRoomId)],
);

export const guestPaymentSources = sqliteTable(
  "guest_payment_sources",
  {
    id: id("id"),
    guestId: text("guest_id").notNull().references(() => guests.id),
    label: text("label").notNull(),
    last4: text("last4"),
    tokenReference: text("token_reference").notNull(),
    expirationMonth: text("expiration_month"),
    expirationYear: text("expiration_year"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (table) => [index("guest_payment_sources_guest_idx").on(table.guestId)],
);

export const reservationExtraGuests = sqliteTable(
  "reservation_extra_guests",
  {
    id: id("id"),
    reservationId: text("reservation_id").notNull().references(() => reservations.id),
    guestId: text("guest_id").references(() => guests.id),
    name: text("name").notNull(),
    driverLicenseNumber: text("driver_license_number"),
    createdAt: createdAt(),
  },
  (table) => [index("reservation_extra_guests_reservation_idx").on(table.reservationId)],
);

export const reservationSignatures = sqliteTable(
  "reservation_signatures",
  {
    id: id("id"),
    reservationId: text("reservation_id").notNull().references(() => reservations.id),
    signedName: text("signed_name").notNull(),
    termsVersion: text("terms_version").notNull(),
    acceptedAt: text("accepted_at").notNull(),
  },
  (table) => [index("reservation_signatures_reservation_idx").on(table.reservationId)],
);

export const reservationCharges = sqliteTable(
  "reservation_charges",
  {
    id: id("id"),
    reservationId: text("reservation_id").notNull().references(() => reservations.id),
    type: text("type").notNull(),
    description: text("description").notNull(),
    serviceDate: text("service_date").notNull(),
    quantity: integer("quantity").notNull(),
    unitAmountCents: integer("unit_amount_cents").notNull(),
    amountCents: integer("amount_cents").notNull(),
    taxable: integer("taxable", { mode: "boolean" }).notNull(),
    taxAmountCents: integer("tax_amount_cents").notNull(),
    status: text("status").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("reservation_charges_reservation_idx").on(table.reservationId)],
);

export const payments = sqliteTable(
  "payments",
  {
    id: id("id"),
    reservationId: text("reservation_id").references(() => reservations.id),
    companyId: text("company_id").references(() => companies.id),
    type: text("type").notNull(),
    amountCents: integer("amount_cents").notNull(),
    effectiveDate: text("effective_date").notNull(),
    status: text("status").notNull(),
    reference: text("reference"),
    note: text("note"),
    recordedByEmployeeId: text("recorded_by_employee_id").references(() => employees.id),
    createdAt: createdAt(),
  },
  (table) => [index("payments_reservation_idx").on(table.reservationId)],
);

export const housekeepingRecords = sqliteTable(
  "housekeeping_records",
  {
    id: id("id"),
    propertyId: text("property_id").notNull().references(() => properties.id),
    roomId: text("room_id").notNull().references(() => rooms.id),
    employeeId: text("employee_id").references(() => employees.id),
    serviceDate: text("service_date").notNull(),
    serviceType: text("service_type").notNull(),
    status: text("status").notNull(),
    assignedAt: text("assigned_at"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("housekeeping_room_date_idx").on(table.roomId, table.serviceDate)],
);

export const maintenanceWorkOrders = sqliteTable(
  "maintenance_work_orders",
  {
    id: id("id"),
    propertyId: text("property_id").notNull().references(() => properties.id),
    roomId: text("room_id").notNull().references(() => rooms.id),
    note: text("note").notNull(),
    status: text("status").notNull(),
    blockRoom: integer("block_room", { mode: "boolean" }).notNull(),
    blockReason: text("block_reason"),
    blockFrom: text("block_from"),
    blockTo: text("block_to"),
    unblockReason: text("unblock_reason"),
    unblockedAt: text("unblocked_at"),
    createdByEmployeeId: text("created_by_employee_id").references(() => employees.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("maintenance_room_status_idx").on(table.roomId, table.status)],
);

export const timeEntries = sqliteTable(
  "time_entries",
  {
    id: id("id"),
    employeeId: text("employee_id").notNull().references(() => employees.id),
    clockInAt: text("clock_in_at").notNull(),
    clockOutAt: text("clock_out_at"),
    breakStartAt: text("break_start_at"),
    breakEndAt: text("break_end_at"),
    breakMinutes: integer("break_minutes").notNull(),
    status: text("status").notNull(),
    editReason: text("edit_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("time_entries_employee_idx").on(table.employeeId, table.clockInAt)],
);

export const expenses = sqliteTable(
  "expenses",
  {
    id: id("id"),
    propertyId: text("property_id").notNull().references(() => properties.id),
    expenseDate: text("expense_date").notNull(),
    category: text("category").notNull(),
    vendor: text("vendor").notNull(),
    description: text("description").notNull(),
    paymentMethod: text("payment_method").notNull(),
    amountCents: integer("amount_cents").notNull(),
    notes: text("notes"),
    receiptReference: text("receipt_reference"),
    recurring: integer("recurring", { mode: "boolean" }).notNull().default(false),
    recurrence: text("recurrence"),
    nextDueDate: text("next_due_date"),
    status: text("status").notNull(),
    enteredByEmployeeId: text("entered_by_employee_id").references(() => employees.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("expenses_property_date_idx").on(table.propertyId, table.expenseDate)],
);

export const cashDrops = sqliteTable(
  "cash_drops",
  {
    id: id("id"),
    propertyId: text("property_id").notNull().references(() => properties.id),
    dropDate: text("drop_date").notNull(),
    shift: text("shift").notNull(),
    expectedCents: integer("expected_cents").notNull(),
    countedCents: integer("counted_cents").notNull(),
    differenceCents: integer("difference_cents").notNull(),
    droppedCents: integer("dropped_cents").notNull(),
    managerEmployeeId: text("manager_employee_id").references(() => employees.id),
    status: text("status").notNull(),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (table) => [index("cash_drops_property_date_idx").on(table.propertyId, table.dropDate)],
);

export const propertyTasks = sqliteTable(
  "property_tasks",
  {
    id: id("id"),
    propertyId: text("property_id").notNull().references(() => properties.id),
    text: text("text").notNull(),
    area: text("area").notNull(),
    completed: integer("completed", { mode: "boolean" }).notNull(),
    completedAt: text("completed_at"),
    createdByEmployeeId: text("created_by_employee_id").references(() => employees.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("property_tasks_property_completed_idx").on(table.propertyId, table.completed)],
);

export const savedReportDefinitions = sqliteTable(
  "saved_report_definitions",
  {
    id: id("id"),
    propertyId: text("property_id").notNull().references(() => properties.id),
    name: text("name").notNull(),
    baseReportId: text("base_report_id").notNull(),
    columnKeysJson: text("column_keys_json").notNull(),
    filtersJson: text("filters_json").notNull().default("{}"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("saved_reports_property_name_key").on(table.propertyId, table.name)],
);

export const notifications = sqliteTable(
  "notifications",
  {
    id: id("id"),
    propertyId: text("property_id").notNull().references(() => properties.id),
    employeeId: text("employee_id").references(() => employees.id),
    type: text("type").notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    href: text("href"),
    status: text("status").notNull().default("Unread"),
    readAt: text("read_at"),
    resolvedAt: text("resolved_at"),
    createdAt: createdAt(),
  },
  (table) => [index("notifications_property_status_idx").on(table.propertyId, table.status)],
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: id("id"),
    propertyId: text("property_id").notNull().references(() => properties.id),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    storageKey: text("storage_key").notNull(),
    originalName: text("original_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    deleteAfter: text("delete_after"),
    warnedAt: text("warned_at"),
    deletedAt: text("deleted_at"),
    createdAt: createdAt(),
  },
  (table) => [index("attachments_property_resource_idx").on(table.propertyId, table.resourceType, table.resourceId)],
);

export const documentSequences = sqliteTable(
  "document_sequences",
  {
    id: id("id"), propertyId: text("property_id").notNull().references(() => properties.id),
    prefix: text("prefix").notNull(), format: text("format").notNull(), nextNumber: integer("next_number").notNull(),
    annualReset: integer("annual_reset", { mode: "boolean" }).notNull().default(false), resetYear: integer("reset_year"), updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("document_sequences_property_key").on(table.propertyId)],
);

export const registrationRuleVersions = sqliteTable(
  "registration_rule_versions",
  {
    id: id("id"), propertyId: text("property_id").notNull().references(() => properties.id), versionNumber: integer("version_number").notNull(),
    content: text("content").notNull(), active: integer("active", { mode: "boolean" }).notNull().default(true), createdAt: createdAt(),
  },
  (table) => [uniqueIndex("registration_rules_property_version_key").on(table.propertyId, table.versionNumber)],
);

export const registrationAcceptances = sqliteTable(
  "registration_acceptances",
  {
    id: id("id"), propertyId: text("property_id").notNull().references(() => properties.id), reservationId: text("reservation_id").notNull().references(() => reservations.id),
    ruleVersionId: text("rule_version_id").notNull().references(() => registrationRuleVersions.id), signedName: text("signed_name").notNull(), signatureStorageKey: text("signature_storage_key"), acceptedAt: text("accepted_at").notNull(),
  },
  (table) => [index("registration_acceptances_reservation_idx").on(table.reservationId)],
);

export const documentRecords = sqliteTable(
  "document_records",
  {
    id: id("id"), propertyId: text("property_id").notNull().references(() => properties.id), reservationId: text("reservation_id").references(() => reservations.id),
    companyId: text("company_id").references(() => companies.id), documentNumber: text("document_number").notNull(), documentType: text("document_type").notNull(),
    status: text("status").notNull(), totalCents: integer("total_cents").notNull().default(0), balanceCents: integer("balance_cents").notNull().default(0),
    dueDate: text("due_date"), sentAt: text("sent_at"), version: integer("version").notNull().default(1), createdAt: createdAt(), updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("document_records_property_number_key").on(table.propertyId, table.documentNumber)],
);

export const ledgerEntries = sqliteTable(
  "ledger_entries",
  {
    id: id("id"), propertyId: text("property_id").notNull().references(() => properties.id), businessDate: text("business_date").notNull(),
    account: text("account").notNull(), debitCents: integer("debit_cents").notNull().default(0), creditCents: integer("credit_cents").notNull().default(0),
    resourceType: text("resource_type").notNull(), resourceId: text("resource_id").notNull(), description: text("description").notNull(), createdAt: createdAt(),
  },
  (table) => [index("ledger_entries_property_date_idx").on(table.propertyId, table.businessDate)],
);

export const nightAuditRuns = sqliteTable(
  "night_audit_runs",
  {
    id: id("id"), propertyId: text("property_id").notNull().references(() => properties.id), businessDate: text("business_date").notNull(),
    status: text("status").notNull(), blockingIssuesJson: text("blocking_issues_json").notNull().default("[]"), startedAt: text("started_at").notNull(), completedAt: text("completed_at"),
  },
  (table) => [uniqueIndex("night_audit_property_date_key").on(table.propertyId, table.businessDate)],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: id("id"),
    propertyId: text("property_id").notNull().references(() => properties.id),
    actorEmployeeId: text("actor_employee_id").references(() => employees.id),
    occurredAt: text("occurred_at").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    reason: text("reason"),
    safeChangeSummary: text("safe_change_summary"),
  },
  (table) => [index("audit_events_entity_idx").on(table.entityType, table.entityId)],
);

export const changeEvents = sqliteTable(
  "change_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    propertyId: text("property_id").notNull().references(() => properties.id),
    actorAuthUserId: text("actor_auth_user_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    entityVersion: integer("entity_version").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    occurredAt: text("occurred_at").notNull(),
  },
  (table) => [index("change_events_property_id_idx").on(table.propertyId, table.id)],
);

export type Property = typeof properties.$inferSelect;
export type NewProperty = typeof properties.$inferInsert;
export type PropertyMembership = typeof propertyMemberships.$inferSelect;
export type NewPropertyMembership = typeof propertyMemberships.$inferInsert;
export type RoomType = typeof roomTypes.$inferSelect;
export type NewRoomType = typeof roomTypes.$inferInsert;
export type Room = typeof rooms.$inferSelect;
export type NewRoom = typeof rooms.$inferInsert;
export type Guest = typeof guests.$inferSelect;
export type NewGuest = typeof guests.$inferInsert;
export type GuestVehicle = typeof guestVehicles.$inferSelect;
export type NewGuestVehicle = typeof guestVehicles.$inferInsert;
export type GuestPaymentSource = typeof guestPaymentSources.$inferSelect;
export type NewGuestPaymentSource = typeof guestPaymentSources.$inferInsert;
export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type BookingChannel = typeof bookingChannels.$inferSelect;
export type NewBookingChannel = typeof bookingChannels.$inferInsert;
export type BusinessDay = typeof businessDays.$inferSelect;
export type NewBusinessDay = typeof businessDays.$inferInsert;
export type Employee = typeof employees.$inferSelect;
export type NewEmployee = typeof employees.$inferInsert;
export type Reservation = typeof reservations.$inferSelect;
export type NewReservation = typeof reservations.$inferInsert;
export type ReservationExtraGuest = typeof reservationExtraGuests.$inferSelect;
export type NewReservationExtraGuest = typeof reservationExtraGuests.$inferInsert;
export type ReservationSignature = typeof reservationSignatures.$inferSelect;
export type NewReservationSignature = typeof reservationSignatures.$inferInsert;
export type ReservationCharge = typeof reservationCharges.$inferSelect;
export type NewReservationCharge = typeof reservationCharges.$inferInsert;
export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type HousekeepingRecord = typeof housekeepingRecords.$inferSelect;
export type NewHousekeepingRecord = typeof housekeepingRecords.$inferInsert;
export type MaintenanceWorkOrder = typeof maintenanceWorkOrders.$inferSelect;
export type NewMaintenanceWorkOrder = typeof maintenanceWorkOrders.$inferInsert;
export type TimeEntry = typeof timeEntries.$inferSelect;
export type NewTimeEntry = typeof timeEntries.$inferInsert;
export type Expense = typeof expenses.$inferSelect;
export type NewExpense = typeof expenses.$inferInsert;
export type CashDrop = typeof cashDrops.$inferSelect;
export type NewCashDrop = typeof cashDrops.$inferInsert;
export type PropertyTask = typeof propertyTasks.$inferSelect;
export type NewPropertyTask = typeof propertyTasks.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
