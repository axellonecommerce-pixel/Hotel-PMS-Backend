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
      roomTypeName: "Standard One King Bed", nightlyRatesCents: [6930, 7500], taxCents: 1443, totalCents: 15873,
    });
  });

  test("labels and values on one line read the same", () => {
    const oneLine = sellvel.replace(/\nPrice Per Night\n/, "\nPrice Per Night ").replace(/\)\n(\d)/g, ") $1").replace(/Room\/s\n/, "Room/s ").replace(/%\)\n/, "%) ").replace(/Total\n/, "Total ");
    const booking = parseBookingEmail({ subject: "Reservation", text: oneLine });
    expect(booking?.nightlyRatesCents).toEqual([6930, 7500]);
    expect(booking?.totalCents).toBe(15873);
    expect(booking?.taxCents).toBe(1443);
  });

  test("a Booking.com booking through Stayflexi", () => {
    expect(parseBookingEmail(stayflexi)).toEqual({
      provider: "Stayflexi", kind: "new", channel: "Booking.com", confirmation: "SFBOOKING_35939_4733295424", channelConfirmation: "5766000000",
      firstName: "Jordan", lastName: "Example", checkIn: "2026-10-24", checkout: "2026-10-25", adults: 1, children: 0, rooms: 1,
      roomTypeName: "Standard 1 King", nightlyRatesCents: [7499], taxCents: 750, totalCents: 8249, commissionCents: 1125,
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
