import { expect, test } from "bun:test";

import { encode, isLiveKey, isStripeKey } from "./stripe";

test("Stripe form encoding handles arrays and nested objects", () => {
  expect(decodeURIComponent(encode({ amount: 100, payment_method_types: ["card_present"], metadata: { pms_id: "a b" }, skip: undefined }).join("&")))
    .toBe("amount=100&payment_method_types[]=card_present&metadata[pms_id]=a b");
  expect(decodeURIComponent(encode({ arrival_date: { gte: 5 } }).join("&"))).toBe("arrival_date[gte]=5");
});

test("only Stripe secret or restricted keys are accepted", () => {
  expect(isStripeKey("rk_live_abcdefghijklmnop")).toBe(true);
  expect(isStripeKey("sk_test_abcdefghijklmnop")).toBe(true);
  expect(isStripeKey("pk_live_abcdefghijklmnop")).toBe(false);
  expect(isLiveKey("rk_live_abcdefghijklmnop")).toBe(true);
  expect(isLiveKey("sk_test_abcdefghijklmnop")).toBe(false);
});
