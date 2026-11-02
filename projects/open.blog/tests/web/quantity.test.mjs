// Tests for recipe amounts and timers (web/components/ob-quantity.js).
// Run with: node --test tests/web/
import test from "node:test";
import assert from "node:assert/strict";
import { findDurations, findQuantity, formatAmount, formatClock, parseAmount, scaleAlso, scaleQuantity } from "../../web/components/ob-quantity.js";

test("reads the amounts cooks write", () => {
  assert.equal(parseAmount("2"), 2);
  assert.equal(parseAmount("1.5"), 1.5);
  assert.equal(parseAmount("1,5"), 1.5);
  assert.equal(parseAmount("1/2"), 0.5);
  assert.equal(parseAmount("1 1/2"), 1.5);
  assert.equal(parseAmount("½"), 0.5);
  assert.equal(parseAmount("1½"), 1.5);
  assert.ok(Number.isNaN(parseAmount("1/0")));
});

test("finds the quantity at the start of an ingredient line", () => {
  const q = findQuantity("1 1/2 cups flour");
  assert.deepEqual([q.start, q.end, q.values, q.fractions], [0, 5, [1.5], true]);
  assert.deepEqual(findQuantity("2–3 cloves garlic").values, [2, 3]);
  assert.equal(findQuantity("2–3 cloves garlic").separator, "–");
  assert.deepEqual(findQuantity("400g spaghetti").values, [400]);
  assert.deepEqual(findQuantity("  ½ lemon").values, [0.5]);
  assert.equal(findQuantity("  ½ lemon").start, 2);
  assert.equal(findQuantity("Salt, to taste"), null);
  assert.equal(findQuantity("0 eggs"), null);
});

test("scales and formats amounts readably", () => {
  const scale = (line, factor) => scaleQuantity(findQuantity(line), factor);
  assert.equal(scale("1/2 cup milk", 2), "1");
  assert.equal(scale("1 cup milk", 1.5), "1½");
  assert.equal(scale("1 1/2 cups flour", 0.5), "¾");
  assert.equal(scale("3 eggs", 1 / 3), "1");
  assert.equal(scale("2 eggs", 0.75), "1½");
  assert.equal(scale("400 g pasta", 1.5), "600");
  assert.equal(scale("250 ml stock", 0.75), "188", "millilitres are whole numbers from 10 up");
  assert.equal(scale("2-3 cloves", 2), "4-6");
  assert.equal(scale("1,5 l water", 2), "3");
  assert.equal(scale("1,5 l water", 1.5), "2,25");
  assert.equal(formatAmount(0.333), "⅓");
  assert.equal(formatAmount(45.6), "45.6");
});

test("finds durations in steps for timers", () => {
  const d = (s) => findDurations(s).map((x) => [s.slice(x.index, x.index + x.length), x.seconds]);
  assert.deepEqual(d("Boil for 10 minutes, then rest 5 mins."), [["10 minutes", 600], ["5 mins", 300]]);
  assert.deepEqual(d("Bake 20-25 minutes"), [["20-25 minutes", 1200]], "a range starts at its shorter end");
  assert.deepEqual(d("Roast 1 hour 30 minutes"), [["1 hour 30 minutes", 5400]]);
  assert.deepEqual(d("Simmer 1 hour and 15 mins"), [["1 hour and 15 mins", 4500]]);
  assert.deepEqual(d("Rest ½ hour"), [["½ hour", 1800]]);
  assert.deepEqual(d("Whisk for 30 seconds"), [["30 seconds", 30]]);
  assert.deepEqual(d("Use 2 minced cloves"), []);
  assert.deepEqual(d("Cook 5 minutes. Cook 1 hour."), [["5 minutes", 300], ["1 hour", 3600]]);
  assert.equal(formatClock(75), "1:15");
  assert.equal(formatClock(3725), "1:02:05");
  assert.equal(formatClock(-3), "0:00");
});

test("reads US mixed numbers, digit grouping and the fraction slash", () => {
  const scale = (line, factor) => scaleQuantity(findQuantity(line), factor);
  assert.deepEqual(findQuantity("1-1/2 cups milk").values, [1.5], "1-1/2 is one amount, not a range");
  assert.equal(scale("1-1/2 cups milk", 2), "3");
  assert.equal(scale("2-1/4 cups flour", 2), "4½");
  assert.deepEqual(findQuantity("1,000 g flour").values, [1000]);
  assert.equal(scale("1,000 g flour", 2), "2,000");
  assert.equal(scale("1,250 g flour", 0.5), "625");
  assert.deepEqual(findQuantity("1⁄2 cup sugar").values, [0.5]);
  assert.equal(scale("1⁄2 cup sugar", 2), "1");
  assert.deepEqual(findQuantity("1/2-3/4 tsp salt").values, [0.5, 0.75], "a range of fractions");
});

test("scales the second measure too", () => {
  const q = findQuantity("12 oz / 340 g pasta");
  assert.equal(scaleQuantity(q, 2), "24");
  assert.equal(scaleAlso(q, 2), "680");
  const cup = findQuantity("1 cup (240 ml) stock");
  assert.equal(scaleAlso(cup, 0.5), "120");
  assert.equal(findQuantity("1 (14 oz) can tomatoes").also, undefined, "the can size is not scaled");
  assert.equal(findQuantity("2 x 400 g tins").also, undefined);
});

test("scaled amounts are measurable and never zero", () => {
  const scale = (line, factor) => scaleQuantity(findQuantity(line), factor);
  assert.equal(scale("1/3 cup oil", 0.5), "⅙");
  assert.equal(scale("3/4 cup sugar", 0.75), "½", "9/16 rounds to a measurable fraction");
  assert.equal(scale("2 1/4 tsp yeast", 1.25), "2⅚");
  assert.equal(scale("25-30 g butter", 0.75), "19-23", "both ends in one style; grams are whole");
  assert.equal(scale("100ml cream", 1 / 12), "8.3");
  for (const line of ["1/8 tsp salt", "1/16 tsp", "1 pinch", "2 eggs", "400 g", "1,5 l"]) {
    for (let k = 1; k <= 12; k += 1) {
      for (const factor of [k, 1 / k]) {
        const text = scale(line, factor);
        assert.ok(!/^0([.,]0*)?$/.test(text) && !/NaN|Infinity/.test(text), `${line} x ${factor} = ${text}`);
      }
    }
  }
});

test("timers read mixed numbers and joined units", () => {
  const d = (s) => findDurations(s).map((x) => [s.slice(x.index, x.index + x.length), x.seconds]);
  assert.deepEqual(d("Bake 1 1/2 hours"), [["1 1/2 hours", 5400]]);
  assert.deepEqual(d("Bake 1½ hours"), [["1½ hours", 5400]]);
  assert.deepEqual(d("Bake 3 ½ hours"), [["3 ½ hours", 12600]]);
  assert.deepEqual(d("Cook 1⅓ hours"), [["1⅓ hours", 4800]]);
  assert.deepEqual(d("Mix 2 minutes 30 seconds"), [["2 minutes 30 seconds", 150]]);
  assert.deepEqual(d("Cook 2 hours, 15 minutes and 30 seconds"), [["2 hours, 15 minutes and 30 seconds", 8130]]);
  assert.deepEqual(d("Heat to 350 F for 9 inch pans"), []);
});

test("containers, 'each' and compound measures are not scaled as a second measure", () => {
  for (const line of ["1 can (400 g) chopped tomatoes", "2 tins (400g each) chickpeas", "1 package (8 oz) cream cheese", "500 g (1 lb 2 oz) flour", "500g/1lb 2oz flour"]) {
    assert.equal(findQuantity(line).also, undefined, line);
  }
  assert.equal(scaleAlso(findQuantity("12 oz / 340 g pasta"), 2), "680");
});

test("ranges keep one style and collapse when their ends meet", () => {
  const scale = (line, factor) => scaleQuantity(findQuantity(line), factor);
  assert.equal(scale("1/2-1 tsp", 1 / 12), "0.04-0.08");
  assert.equal(scale("1 1/2-2 cups", 0.1), "⅙");
});

test("timers: US mixed numbers, cross-unit ranges and abbreviation dots", () => {
  const d = (s) => findDurations(s).map((x) => [s.slice(x.index, x.index + x.length), x.seconds]);
  assert.deepEqual(d("Roast 1-1/2 hours."), [["1-1/2 hours", 5400]]);
  assert.deepEqual(d("Cook 45 minutes to 1 hour."), [["45 minutes to 1 hour", 2700]]);
  assert.deepEqual(d("Bake 1 hr. 20 min."), [["1 hr. 20 min", 4800]]);
});
