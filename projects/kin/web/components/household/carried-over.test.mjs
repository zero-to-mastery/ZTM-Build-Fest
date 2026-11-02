// The wording for devices carried over from the old address (#769).
import assert from "node:assert/strict";
import test from "node:test";
import { CARRIED_OVER_STATUS, carriedOverButtonLabel, carriedOverConfirmation, joinNames } from "./carried-over.js";

test("the button and status say what the devices are", () => {
  assert.equal(carriedOverButtonLabel(2), "Remove the 2 devices from the old address");
  assert.equal(carriedOverButtonLabel(1), "Remove the device from the old address");
  assert.equal(CARRIED_OVER_STATUS, "From the old address · can't sign in here");
});

test("names are joined as a sentence", () => {
  assert.equal(joinNames([]), "");
  assert.equal(joinNames(["Sam"]), "Sam");
  assert.equal(joinNames(["Sam", "Household member 2"]), "Sam and Household member 2");
  assert.equal(joinNames(["Sam", "Robin", "Household member 3"]), "Sam, Robin and Household member 3");
});

test("when everyone has signed in here, the confirmation says so", () => {
  assert.equal(carriedOverConfirmation({ count: 3, waiting: [] }),
    "Remove the 3 devices from the old address? None of them can sign in here. Everyone they belong to has signed in here on another device.");
  assert.equal(carriedOverConfirmation({ count: 1 }),
    "Remove the device from the old address? It can't sign in here. The person it belongs to has signed in here on another device.");
});

test("members who haven't signed in here are named, with how they still can", () => {
  const one = carriedOverConfirmation({ count: 2, waiting: ["Sam"] });
  assert.match(one, /^Remove the 2 devices from the old address\? None of them can sign in here\. Sam hasn't signed in here yet\./);
  assert.match(one, /password or backup code/);
  assert.match(one, /recovery invitation/);
  assert.match(one, /won't appear among the people you can assign things to/);
  assert.match(one, /doesn't remove anyone from the household/);

  const two = carriedOverConfirmation({ count: 4, waiting: ["Sam", "Household member 2"] });
  assert.match(two, /Sam and Household member 2 haven't signed in here yet\./);
  assert.doesNotMatch(two, /[a-f0-9]{32}/, "members are named by label, never by ID");

  const single = carriedOverConfirmation({ count: 1, waiting: ["Household member 1"] });
  assert.match(single, /^Remove the device from the old address\? It can't sign in here\. Household member 1 hasn't signed in here yet\./);
});
