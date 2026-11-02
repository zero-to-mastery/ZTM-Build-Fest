import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDay, compareDays, runPromotion, promotionalPrice, monthlyEstimate,
  moneyToCents, validateSetup, validateExperiment, GUIDED,
  parsePromotionDraft, parseExperimentDraft, INPUT_LIMITS } from '../src/model.js';

test('normal day reconciles revenue, both cost groups and profit', () => {
  const day = calculateDay(GUIDED);
  assert.equal(day.revenueCents, 50000);
  assert.equal(day.variableCostCents, 20000);
  assert.equal(day.totalCostCents, 45000);
  assert.equal(day.profitCents, 5000);
});

for (const [cups, extraStaffCents, profit, outcome, comparison] of [
  [140, 0, 10000, 'profit', 'better'], [110, 0, 2500, 'profit', 'worse'],
  [120, 0, 5000, 'profit', 'same'], [100, 0, 0, 'break-even', 'worse'],
  [140, 5000, 5000, 'profit', 'same'], [140, 10000, 0, 'break-even', 'worse'],
  [140, 15000, -5000, 'loss', 'worse']
]) test(`${cups} cups and ${extraStaffCents} staff cents: ${outcome}, ${comparison}`, () => {
  const run = runPromotion(GUIDED, { cups, extraStaffCents });
  assert.equal(run.day.profitCents, profit);
  assert.equal(run.outcome, outcome);
  assert.equal(run.comparison, comparison);
  assert.equal(run.differenceCents, profit - 5000);
});

test('custom baseline determines price and comparison, including a losing baseline', () => {
  const run = runPromotion({ cups: 80, priceCents: 300 }, { cups: 140, extraStaffCents: 0 });
  assert.equal(run.baseline.profitCents, -17000);
  assert.equal(run.day.priceCents, 270);
  assert.equal(run.day.profitCents, -15200);
  assert.equal(run.outcome, 'loss');
  assert.equal(run.comparison, 'better');
  assert.equal(run.differenceCents, 1800);
});

test('percentage rule is reusable and rounds the unit price once', () => {
  assert.equal(promotionalPrice(555, { kind: 'percent-off', percent: 10 }), 500);
  assert.equal(promotionalPrice(500, { kind: 'percent-off', percent: 25 }), 375);
  assert.equal(promotionalPrice(500, { kind: 'percent-off', percent: 100 }), 0);
  assert.equal(promotionalPrice(500, { kind: 'percent-off', percent: 0 }), 500);
  assert.throws(() => promotionalPrice(500, { kind: 'coupon', percent: 10 }));
  for (const percent of [-1, 101, NaN, 1.5]) assert.throws(() => promotionalPrice(500, { kind: 'percent-off', percent }));
});

test('every supported setup has an exact discounted unit price and consistent ledger', () => {
  for (let cups = 80; cups <= 180; cups += 10) for (let priceCents = 300; priceCents <= 1000; priceCents += 50) {
    const run = runPromotion({ cups, priceCents }, { cups: 140, extraStaffCents: 5000 });
    assert.equal(run.day.priceCents, priceCents * 0.9);
    assert.equal(run.day.revenueCents - run.day.totalCostCents, run.day.profitCents);
  }
});

test('repeated runs never mutate the baseline or append sales/costs', () => {
  const setup = { ...GUIDED };
  const inputs = { cups: 140, extraStaffCents: 0 };
  const first = runPromotion(setup, inputs);
  const second = runPromotion(setup, inputs);
  assert.deepEqual(first, second);
  inputs.cups = 80;
  assert.equal(first.inputs.cups, 140);
  assert.deepEqual(setup, GUIDED);
  assert.ok(Object.isFrozen(first.day));
});

test('monthly estimate multiplies all included financial lines, including losses', () => {
  for (const staff of [0, 15000]) {
    const day = runPromotion(GUIDED, { cups: 140, extraStaffCents: staff }).day;
    const month = monthlyEstimate(day);
    assert.equal(month.profitCents, staff ? -130000 : 260000);
    assert.equal(month.revenueCents - month.totalCostCents, month.profitCents);
    assert.equal(month.totalCostCents, month.variableCostCents + month.operatingCostCents + month.extraStaffCents);
  }
});

test('invalid, fractional and missing inputs cannot become zero silently', () => {
  for (const text of ['', ' ', 'abc', 'Infinity', '-5', '4.999']) assert.throws(() => moneyToCents(text));
  assert.equal(moneyToCents('5.5'), 550);
  assert.equal(moneyToCents(' 5.00 '), 500);
  for (const cups of [0, 79, 85, 181, NaN, Infinity, undefined]) assert.throws(() => validateSetup({ cups, priceCents: 500 }));
  for (const priceCents of [299, 325, 1001, NaN]) assert.throws(() => validateSetup({ cups: 100, priceCents }));
  assert.throws(() => validateExperiment({ cups: 140, extraStaffCents: 1 }));
  assert.equal(compareDays(calculateDay({ cups: 0, priceCents: 500 }), calculateDay(GUIDED)).outcome, 'loss');
});

test('editable promotion price and discount leave the normal-day reference unchanged', () => {
  const setup = { ...GUIDED };
  const run = runPromotion(setup, { cups: 140, extraStaffCents: 0, priceCents: 600 }, { kind: 'percent-off', percent: 25 });
  assert.equal(run.priceBeforeDiscountCents, 600);
  assert.equal(run.day.priceCents, 450);
  assert.equal(run.day.profitCents, 10000);
  assert.equal(run.baseline.priceCents, 500);
  assert.equal(run.baseline.profitCents, 5000);
  assert.deepEqual(setup, GUIDED);
});

test('no discount and free-drink promotions reconcile without special revenue paths', () => {
  for (const [percent, expectedPrice, expectedProfit] of [[0, 550, 24000], [100, 0, -53000]]) {
    const run = runPromotion(GUIDED, { cups: 140, extraStaffCents: 0, priceCents: 550 }, { kind: 'percent-off', percent });
    assert.equal(run.day.priceCents, expectedPrice);
    assert.equal(run.day.profitCents, expectedProfit);
    assert.equal(run.day.revenueCents - run.day.totalCostCents, expectedProfit);
  }
});

test('custom discount rounding is applied per cup before multiplying turnout', () => {
  const run = runPromotion(GUIDED, { cups: 140, extraStaffCents: 0, priceCents: 550 }, { kind: 'percent-off', percent: 15 });
  assert.equal(run.day.priceCents, 468);
  assert.equal(run.day.revenueCents, 65520);
  assert.equal(run.day.profitCents, 12520);
  const month = monthlyEstimate(run.day);
  assert.equal(month.profitCents, 325520);
});

test('invalid editable price or discount cannot produce a completed run', () => {
  for (const priceCents of [0, 299, 325, 1001, NaN, Infinity]) {
    assert.throws(() => runPromotion(GUIDED, { cups: 140, extraStaffCents: 0, priceCents }));
  }
  for (const percent of [-1, 101, 10.5, NaN]) {
    assert.throws(() => runPromotion(GUIDED, { cups: 140, extraStaffCents: 0 }, { kind: 'percent-off', percent }));
  }
});

test('price preview and submitted campaign share parsing and cent rounding', () => {
  const draft = { cups: '150', staffing: '5000', price: '3.50', discount: '13' };
  const preview = parsePromotionDraft(draft);
  const submitted = parseExperimentDraft(draft);
  assert.equal(promotionalPrice(preview.priceCents, preview.promotion), 305);
  const run = runPromotion(GUIDED, submitted.inputs, submitted.promotion);
  assert.equal(run.day.priceCents, 305);
  assert.equal(run.day.profitCents, -14250);
  assert.equal(monthlyEstimate(run.day).profitCents, -370500);
});

test('missing or blank form values never silently turn into zero', () => {
  const valid = { cups: '140', staffing: '0', price: '5.00', discount: '10' };
  for (const key of Object.keys(valid)) for (const value of ['', ' ', null, undefined, 'NaN', 'Infinity']) {
    assert.throws(() => parseExperimentDraft({ ...valid, [key]: value }), `${key}: ${value}`);
  }
  assert.equal(parsePromotionDraft({ price: '5', discount: '0' }).promotion.percent, 0);
  assert.equal(parseExperimentDraft({ ...valid, discount: '100' }).promotion.percent, 100);
});

test('form parser enforces the same bounds and steps as model input rules', () => {
  const valid = { cups: '140', staffing: '0', price: '5.00', discount: '10' };
  for (const [key, value] of [['cups', '85'], ['cups', '181'], ['price', '5.25'], ['price', '10.50'], ['discount', '12.5'], ['discount', '101'], ['staffing', '25']]) {
    assert.throws(() => parseExperimentDraft({ ...valid, [key]: value }));
  }
  assert.ok(Object.isFrozen(INPUT_LIMITS));
  assert.ok(Object.isFrozen(INPUT_LIMITS.priceCents));
  const low = parseExperimentDraft({ cups: String(INPUT_LIMITS.cups.min), staffing: '0', price: String(INPUT_LIMITS.priceCents.min / 100), discount: String(INPUT_LIMITS.discount.min) });
  assert.equal(low.inputs.cups, 80);
  assert.equal(low.inputs.priceCents, 300);
});
