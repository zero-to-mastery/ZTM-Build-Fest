// Financial rules are independent of artwork, navigation and presentation.
export const LESSON = Object.freeze({ costPerCupCents: 200, operatingCostCents: 25000, tradingDays: 26 });
export const GUIDED = Object.freeze({ cups: 100, priceCents: 500 });
export const PROMOTION = Object.freeze({ kind: 'percent-off', percent: 10 });
export const DEFAULT_EXPERIMENT = Object.freeze({ cups: 140, extraStaffCents: 0 });
export const STAFF_OPTIONS = Object.freeze([0, 5000, 10000, 15000]);
export const INPUT_LIMITS = Object.freeze({
  cups: Object.freeze({ min: 80, max: 180, step: 10 }),
  priceCents: Object.freeze({ min: 300, max: 1000, step: 50 }),
  discount: Object.freeze({ min: 0, max: 100, step: 1 })
});

function integer(value, name, min = 0, max = 100000000) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} is outside the supported range.`);
  return value;
}

export function moneyToCents(value) {
  const text = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new RangeError('Enter a dollar amount with up to two decimal places.');
  const [whole, fraction = ''] = text.split('.');
  return integer(Number(whole) * 100 + Number(fraction.padEnd(2, '0')), 'Price');
}

export function validateSetup({ cups, priceCents }) {
  validateCups(cups);
  validatePrice(priceCents);
  return Object.freeze({ cups, priceCents });
}

export function validateExperiment({ cups, extraStaffCents, priceCents }) {
  validateCups(cups);
  if (!STAFF_OPTIONS.includes(extraStaffCents)) throw new RangeError('Choose an available staffing cost.');
  if (priceCents !== undefined) validatePrice(priceCents);
  return Object.freeze({ cups, extraStaffCents, ...(priceCents !== undefined ? { priceCents } : {}) });
}

function validateCups(cups) {
  const { min, max, step } = INPUT_LIMITS.cups;
  integer(cups, 'Cups', min, max);
  if ((cups - min) % step) throw new RangeError(`Use ${min}–${max} cups, in steps of ${step}.`);
}

function validatePrice(priceCents) {
  const { min, max, step } = INPUT_LIMITS.priceCents;
  integer(priceCents, 'Price', min, max);
  if ((priceCents - min) % step) throw new RangeError(`Use $${min / 100}–$${max / 100}, in steps of $${(step / 100).toFixed(2)}.`);
}

function inputNumber(value, name) {
  if (!['string', 'number'].includes(typeof value) || String(value).trim() === '') throw new RangeError(`Enter ${name}.`);
  return Number(value);
}

function validateDiscount(percent) {
  const { min, max, step } = INPUT_LIMITS.discount;
  integer(percent, 'Discount', min, max);
  if ((percent - min) % step) throw new RangeError(`Use discounts in steps of ${step}%.`);
}

// Shared parsing for editable HTML drafts; financial rules never depend on DOM state.
export function parsePromotionDraft({ price, discount }) {
  const priceCents = moneyToCents(price);
  validatePrice(priceCents);
  const percent = inputNumber(discount, 'a whole-number discount from 0 to 100');
  validateDiscount(percent);
  return Object.freeze({ priceCents, promotion: Object.freeze({ kind: 'percent-off', percent }) });
}

export function parseExperimentDraft({ cups, staffing, price, discount }) {
  const parsed = parsePromotionDraft({ price, discount });
  const inputs = validateExperiment({ cups: inputNumber(cups, 'cups sold'), extraStaffCents: inputNumber(staffing, 'a staffing cost'), priceCents: parsed.priceCents });
  return Object.freeze({ inputs, promotion: parsed.promotion });
}

// The lesson selects 10%; the rule accepts other percentages without UI changes.
// Other promotion kinds can be added here without changing the day ledger.
export function promotionalPrice(priceCents, promotion = PROMOTION) {
  integer(priceCents, 'Price');
  if (promotion?.kind !== 'percent-off') throw new RangeError('Unsupported promotion type.');
  validateDiscount(promotion.percent);
  // Round the discounted unit price once, then multiply by completed cups.
  return Math.round(priceCents * (100 - promotion.percent) / 100);
}

export function calculateDay({ cups, priceCents, extraStaffCents = 0,
  costPerCupCents = LESSON.costPerCupCents, operatingCostCents = LESSON.operatingCostCents }) {
  integer(cups, 'Cups', 0, 1000000);
  for (const [name, value] of Object.entries({ priceCents, extraStaffCents, costPerCupCents, operatingCostCents })) integer(value, name);
  const revenueCents = cups * priceCents;
  const variableCostCents = cups * costPerCupCents;
  const totalCostCents = variableCostCents + operatingCostCents + extraStaffCents;
  const profitCents = revenueCents - totalCostCents;
  if (![revenueCents, totalCostCents, profitCents].every(Number.isSafeInteger)) throw new RangeError('Totals exceed the supported range.');
  return Object.freeze({ cups, priceCents, costPerCupCents, operatingCostCents, extraStaffCents,
    revenueCents, variableCostCents, totalCostCents, profitCents });
}

export function compareDays(day, baseline) {
  const differenceCents = day.profitCents - baseline.profitCents;
  return Object.freeze({ differenceCents,
    outcome: day.profitCents > 0 ? 'profit' : day.profitCents < 0 ? 'loss' : 'break-even',
    comparison: differenceCents > 0 ? 'better' : differenceCents < 0 ? 'worse' : 'same' });
}

export function runPromotion(setup, experiment, promotion = PROMOTION) {
  const baseline = calculateDay(validateSetup(setup));
  const inputs = validateExperiment(experiment);
  const priceBeforeDiscountCents = inputs.priceCents ?? baseline.priceCents;
  const day = calculateDay({ ...inputs, priceCents: promotionalPrice(priceBeforeDiscountCents, promotion) });
  return Object.freeze({ baseline, day, inputs, priceBeforeDiscountCents,
    promotion: Object.freeze({ ...promotion }), ...compareDays(day, baseline) });
}

export function monthlyEstimate(day, tradingDays = LESSON.tradingDays) {
  integer(tradingDays, 'Trading days', 1, 366);
  const result = { tradingDays };
  for (const key of ['revenueCents', 'variableCostCents', 'operatingCostCents', 'extraStaffCents', 'totalCostCents', 'profitCents']) {
    result[key] = day[key] * tradingDays;
    if (!Number.isSafeInteger(result[key])) throw new RangeError('Monthly total exceeds the supported range.');
  }
  return Object.freeze(result);
}
