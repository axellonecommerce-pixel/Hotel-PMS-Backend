import { describe, expect, test } from "bun:test";

import { matchRoomType, parseBookingEmail, removeCardDetails, roomNameKey } from "./parse-booking-email";

// Made-up guests and a test card number laid out like the real emails.
const sellvel = `New Reservation from Sellvel (Cyberwebhotels)
EXAMPLE INN
100 Main St, Sampletown, CA 90000
Confirmation # : 123456
Booking Summary:
Check-in Date: 11/3/2026
Check-out Date: 11/5/2026
Adult per Room: 2
Children: 1
No of Rooms: 1
Booking Date: 11/3/2026
Payment Method:
Name on card: Pat Example
Card Type: MasterCard
Card Number: 5555-4444-3333-1111
Card Expiry: 5/2031
Guest Details:
Name: Alex Sample
Addr.: 12 Test Rd, Victoria, British Columbia CA V8Z 1A1
Phone: 2505550100
Email: alex.sample@example.com
Cancellation Policy:
Cancellation will result in a penalty of 100% of the stay.
Standard One King Bed Â
Date
Price Per Night
Tue (11/03)
69.30 USD
Wed (11/04)
75.00 USD
Subtotal X 1 Room/s
144.30 USD
Tax (10.00 %)
14.43 USD
Total
158.73 USD
Additional Note: Please note: - Check-out is before 11:00 AM`;

const stayflexi = {
  subject: "New BOOKING.COM booking from Oct 24, 2026 15:00 PM to Oct 25, 2026 11:00 AM (Itinerary #SFBOOKING_35939_4733295424)",
  text: `New BOOKING.COM booking confirmed for Jordan Example, arrives Sat, 24 Oct 03:00 PM.
Send the magic link to Jordan Example to improve guest experience!
Sat
24 October
Check-in 03:00 PM
Sun
25 October
Check-out 11:00 AM
Customer details
Name
Jordan Example
Accomodation details
Name
Example Inn
Room details
Room: Standard 1 King,
Rate plan: Standard Plan, 1Adult(s), 0Children, 0Infant
Confirmation code
SFBOOKING_35939_4733295424
Confirmation pin
AbCdEf
BOOKING.COM Confirmation code
5766000000
Tariff details
Booking Price
74.99 USD
Subtotal (ex. tax)
74.99 USD
Hotel Taxes
7.50 USD
Total charges
82.49 USD
OTA commission
11.25 USD
Net amount received by hotel
71.24 USD
Total payments
0.0 USD`,
};

describe("booking emails", () => {
  test("card numbers and card lines are removed before reading", () => {
    const clean = removeCardDetails(sellvel);
    expect(clean).not.toContain("5555");
    expect(clean).not.toMatch(/Card Expiry|Name on card/);
    expect(removeCardDetails("ref 4111 1111 1111 1111 end")).toBe("ref [card removed] end");
  });

  test("a SellVEL website booking", () => {
    expect(parseBookingEmail({ subject: "Mobile Secured Reservation Form (www.example.com)", text: sellvel })).toEqual({
      provider: "SellVEL", kind: "new", channel: "Website", confirmation: "123456",
      firstName: "Alex", lastName: "Sample", email: "alex.sample@example.com", phone: "2505550100",
      address: "12 Test Rd, Victoria, British Columbia CA V8Z 1A1",
      checkIn: "2026-11-03", checkout: "2026-11-05", adults: 2, children: 1, rooms: 1,
      roomTypeName: "Standard One King Bed", nightlyRatesCents: [6930, 7500], subtotalCents: 14430, taxCents: 1443, totalCents: 15873,
    });
  });

  test("labels and values on one line read the same", () => {
    const oneLine = sellvel.replace(/\nPrice Per Night\n/, "\nPrice Per Night ").replace(/\)\n(\d)/g, ") $1").replace(/Room\/s\n/, "Room/s ").replace(/%\)\n/, "%) ").replace(/Total\n/, "Total ");
    const booking = parseBookingEmail({ subject: "Reservation", text: oneLine });
    expect(booking?.nightlyRatesCents).toEqual([6930, 7500]);
    expect(booking?.totalCents).toBe(15873);
    expect(booking?.taxCents).toBe(1443);
  });

  test("Gmail's plain text: blank lines, *bold*, USD first, no Date heading", () => {
    const messy = sellvel
      .replace(/\n/g, "\n\n")
      .replace("Standard One King Bed Â", "*Standard One King Bed*")
      .replace("\n\nDate\n", "\n")
      .replace(/([\d.]+) USD/g, "USD $1");
    const booking = parseBookingEmail({ subject: "Mobile Secured Reservation Form", text: messy });
    expect(booking?.roomTypeName).toBe("Standard One King Bed");
    expect(booking?.nightlyRatesCents).toEqual([6930, 7500]);
    expect([booking?.subtotalCents, booking?.taxCents, booking?.totalCents]).toEqual([14430, 1443, 15873]);
    expect(booking?.firstName).toBe("Alex");
  });

  test("a Booking.com booking through Stayflexi", () => {
    expect(parseBookingEmail(stayflexi)).toEqual({
      provider: "Stayflexi", kind: "new", channel: "Booking.com", confirmation: "SFBOOKING_35939_4733295424", channelConfirmation: "5766000000",
      firstName: "Jordan", lastName: "Example", checkIn: "2026-10-24", checkout: "2026-10-25", adults: 1, children: 0, rooms: 1,
      roomTypeName: "Standard 1 King", nightlyRatesCents: [7499], subtotalCents: 7499, taxCents: 750, totalCents: 8249, commissionCents: 1125, netCents: 7124, paidCents: 0,
    });
  });

  test("an Expedia booking, several nights, and a cancellation", () => {
    const expedia = parseBookingEmail({
      subject: "New EXPEDIA AFFILIATE NETWORK booking from Oct 23, 2026 15:00 PM to Oct 26, 2026 11:00 AM (Itinerary #SFBOOKING_35939_3937572649)",
      text: stayflexi.text.replace(/BOOKING\.COM/g, "EXPEDIA AFFILIATE NETWORK").replace("74.99 USD\nSubtotal (ex. tax)\n74.99", "100.00 USD\nSubtotal (ex. tax)\n100.00"),
    });
    expect(expedia?.channel).toBe("Expedia");
    expect(expedia?.nightlyRatesCents).toEqual([3333, 3333, 3334]);
    const cancelled = parseBookingEmail({ subject: stayflexi.subject.replace("New BOOKING.COM booking", "Cancelled BOOKING.COM booking"), text: stayflexi.text.replace("New BOOKING.COM booking confirmed", "BOOKING.COM booking cancelled") });
    expect(cancelled?.kind).toBe("cancelled");
    expect(cancelled?.channel).toBe("Booking.com");
  });

  // Laid out like Expedia Partner Central's own email (booknotif@expedia.com); made-up guest.
  const expediaSubject = "Expedia - New Booking - Arriving on 9 Nov 2026";
  const expediaRows = `NOTICE: The following notice is for hotel partners only. All other vendors (including Activity Service Providers) please disregard.
HOTEL RESERVATION CONFIRMATIONS: Please provide booking confirmation code.
Enter confirmation code at www.expediapartnercentral.com
New Reservation
EAN logo
Example Inn Sampletown
Sampletown,CA,USA
Hotel Collects Payment from Guest
Reservation ID: 2599000001
Guest: Casey Sample
1 (209) 5550100
Booked on: Nov 9, 2026 7:26 AM PST
Guest Email: abc123@m.expediapartnercentral.com
Room Type Code: RoomCode
Room Type Name: Standard Room, 1 King Bed - Standard Rate
Pricing Model: Occupancy Based Pricing
Payment Instructions: This guest booked without a credit card and will pay upon arrival.
Check-In Check-Out Adults Kids/Ages Room Nights Hotel Conf
Nov 9, 2026 Nov 10, 2026 2 0 1
Special Request
!LAST-MINUTE BOOKING - NO GUEST NAME CHANGES ALLOWED - PLEASE CHECK ID!
Daily Rate - 79.99 USD
Mon, Nov 09
Rate Code: Standalone
Extra Person: 0.00 USD
Taxes: 8.00 USD
Extra Charges: 0.00 USD
Total:87.99 USD
Nonrefundable`;

  test("Expedia Partner Central: a new booking (table as rows)", () => {
    const booking = parseBookingEmail({ subject: expediaSubject, text: expediaRows });
    expect(booking).toMatchObject({
      provider: "Expedia", kind: "new", channel: "Expedia", confirmation: "2599000001",
      firstName: "Casey", lastName: "Sample", email: "abc123@m.expediapartnercentral.com", phone: "1 (209) 5550100",
      checkIn: "2026-11-09", checkout: "2026-11-10", adults: 2, children: 0, rooms: 1,
      roomTypeName: "Standard Room, 1 King Bed", nightlyRatesCents: [7999], subtotalCents: 7999, taxCents: 800, totalCents: 8799,
    });
    expect(booking?.paidCents).toBeUndefined();
  });

  test("Expedia Partner Central: table one cell per line, two nights, Expedia collects", () => {
    const text = expediaRows
      .replace("Hotel Collects Payment from Guest", "Expedia Collects Payment")
      .replace("Check-In Check-Out Adults Kids/Ages Room Nights Hotel Conf\nNov 9, 2026 Nov 10, 2026 2 0 1", "Check-In\nCheck-Out\nAdults\nKids/Ages\nRoom Nights\nHotel Conf\nNov 9, 2026\nNov 11, 2026\n3\n1\n2")
      .replace("Daily Rate - 79.99 USD\nMon, Nov 09", "Daily Rate - 79.99 USD\nMon, Nov 09\n89.99 USD\nTue, Nov 10")
      .replace("Taxes: 8.00 USD", "Taxes: 17.00 USD").replace("Total:87.99 USD", "Total:186.98 USD");
    const booking = parseBookingEmail({ subject: expediaSubject, text });
    expect(booking).toMatchObject({ checkIn: "2026-11-09", checkout: "2026-11-11", adults: 3, children: 1, nightlyRatesCents: [7999, 8999], totalCents: 18698, paidCents: 18698 });
  });

  // Laid out like a Hotels.com booking through Expedia Partner Central with a
  // virtual card (made-up guest and card): "Guest:" shares the line with the
  // reservation ID, and the price box says "Total Cost:".
  const virtualCardEmail = `NOTICE: The following notice is for hotel partners only. All other vendors (including Activity Service Providers) please disregard.
New Reservation
Hotels.com Example Inn Sampletown
Sampletown,CA,USA
Reservation ID: 2601000002 Guest: Albert Sample Booked on: Nov 12, 2026 2:23 PM PST
1 (0) 2095550111
Guest Email: xyz789@m.expediapartnercentral.com
Room Type Code: RoomCode
Room Type Name: Standard Room, 1 King Bed - Standard Rate
Pricing Model: Occupancy Based Pricing
Payment Instructions: Expedia collects payment from traveler: Hotel charges virtual card.
Check-In Check-Out Adults Kids/Ages Room Nights Hotel Conf
Nov 14, 2026 Nov 15, 2026 2 0 1
Special Request
Daily Rate - 59.03 USD Extra Person: 0.00 USD
Sat, Nov 14 Taxes: 5.90 USD
Rate Code: Standalone Extra Charges: 0.00 USD
Discount: Blue - Contracted Improved Membe Total Cost:64.93 USD
Billing Details:
Card Holder Name virtual card Billing Address 1111 Expedia Group Way W
Card Number 4111-1111-1111-1111
Expiration Date Nov 2029 Seattle, WA 98119
Validation Code 123 USA
Virtual card will be activated from the day of Check-in.
Notes & Instructions
Please bill only the nights booked by Expedia to the virtual card. The guest is responsible for any incidentals.`;

  test("Expedia Partner Central: guest beside the reservation ID, Total Cost, virtual card", () => {
    const booking = parseBookingEmail({ subject: "Expedia - New Booking - Arriving on 14 Nov 2026", text: virtualCardEmail });
    expect(booking).toMatchObject({
      provider: "Expedia", kind: "new", confirmation: "2601000002", firstName: "Albert", lastName: "Sample",
      email: "xyz789@m.expediapartnercentral.com", checkIn: "2026-11-14", checkout: "2026-11-15", adults: 2, children: 0,
      roomTypeName: "Standard Room, 1 King Bed", nightlyRatesCents: [5903], taxCents: 590, totalCents: 6493, paidCents: 6493, virtualCard: true,
    });
    expect(booking?.phone?.replace(/\D/g, "")).toBe("102095550111");
  });

  test("Expedia Partner Central: the same email with every cell on its own line", () => {
    const text = virtualCardEmail
      .replace("Reservation ID: 2601000002 Guest: Albert Sample Booked on: Nov 12, 2026 2:23 PM PST", "Reservation ID: 2601000002\nGuest: Albert Sample\nBooked on: Nov 12, 2026 2:23 PM PST")
      .replace(/ (Extra Person|Taxes|Extra Charges|Total Cost):/g, "\n$1:");
    const booking = parseBookingEmail({ subject: "Expedia - New Booking - Arriving on 14 Nov 2026", text });
    expect(booking).toMatchObject({ firstName: "Albert", lastName: "Sample", nightlyRatesCents: [5903], taxCents: 590, totalCents: 6493, virtualCard: true });
  });

  test("card expiry and validation code lines never get past the card filter", () => {
    const cleaned = removeCardDetails(virtualCardEmail);
    expect(cleaned).not.toMatch(/4111|Expiration Date|Validation Code|\b123\b/);
    expect(cleaned).toMatch(/Total Cost:64\.93/);
  });

  test("Expedia Partner Central: a cancellation", () => {
    const booking = parseBookingEmail({ subject: "Expedia - Cancelled Booking - Arriving on 9 Nov 2026", text: expediaRows.replace("New Reservation", "Cancelled Reservation") });
    expect(booking?.kind).toBe("cancelled");
  });

  test("an email no reader knows is not a booking", () => {
    expect(parseBookingEmail({ subject: "Your invoice", text: "Thanks for your payment" })).toBeNull();
  });

  test("room names match the motel's room types", () => {
    expect(roomNameKey("Standard One King Bed")).toBe(roomNameKey("Standard 1 King"));
    expect(roomNameKey("Deluxe 2 Double Beds")).toBe(roomNameKey("Deluxe 2 Double"));
    const types = [
      { id: "s", name: "Standard 1 King", smokingAllowed: true },
      { id: "n", name: "Standard 1 King", smokingAllowed: false },
      { id: "d", name: "Deluxe 1 King" },
    ];
    expect(matchRoomType("Standard One King Bed", types)?.id).toBe("n");
    expect(matchRoomType("Standard One King Bed", types, { [roomNameKey("Standard One King Bed")]: "s" })?.id).toBe("s");
    expect(matchRoomType("Suite", types)).toBeUndefined();
  });
});
