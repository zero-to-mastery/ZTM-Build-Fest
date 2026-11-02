import { GUIDED, PROMOTION, DEFAULT_EXPERIMENT, STAFF_OPTIONS, LESSON, INPUT_LIMITS,
  calculateDay, validateSetup, moneyToCents, runPromotion,
  promotionalPrice, monthlyEstimate, parsePromotionDraft, parseExperimentDraft } from './model.js';

const app = document.querySelector('#app');
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const money = cents => usd.format(cents / 100);
const wholeMoney = cents => Number.isInteger(cents / 100) ? money(cents).replace('.00', '') : money(cents);
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const freshDraft = (priceCents = GUIDED.priceCents) => ({ cups: String(DEFAULT_EXPERIMENT.cups), staffing: '0', price: (priceCents / 100).toFixed(2), discount: String(PROMOTION.percent) });
const state = { screen: 'welcome', mode: 'guided', setup: GUIDED,
  setupDraft: { cups: '100', price: '5.00' }, drafts: { guided: freshDraft(), explore: freshDraft() },
  runs: { guided: null, explore: null }, dirty: { guided: true, explore: true }, prediction: null, answers: {}, exploreReference: GUIDED };
const baseline = () => calculateDay(state.setup);
const demonstration = () => runPromotion(state.setup, DEFAULT_EXPERIMENT);
const button = (action, label, primary = false) => `<button type="button" data-action="${action}" class="${primary ? 'primary' : 'text-button'}">${label}</button>`;
const heading = text => `<h1 id="main-heading" tabindex="-1">${text}</h1>`;
const costs = () => `<details><summary>Cost assumptions</summary><p>${money(LESSON.costPerCupCents)} per cup; ${wholeMoney(LESSON.operatingCostCents)} daily operating costs, including base staffing.</p></details>`;
function ledger(day, label = 'Daily breakdown') {
  return `<table class="ledger"><caption>${label}</caption><tbody>${[
    ['Revenue', day.revenueCents], ['Ingredients & packaging', day.variableCostCents],
    ['Base staffing, rent & utilities', day.operatingCostCents], ['Extra staffing', day.extraStaffCents],
    ['Total costs', day.totalCostCents], ['Profit after these costs', day.profitCents]
  ].map(([key, value], index) => `<tr class="${index >= 4 ? 'total' : ''}"><th scope="row">${key}</th><td>${wholeMoney(value)}</td></tr>`).join('')}</tbody></table>`;
}
function header(title) {
  return `<header class="header"><button class="brand" data-action="home" type="button" aria-label="Anna’s Tea — back to welcome">Anna’s Tea</button><div class="header-side">${heading(title)}${button('restart', 'Restart lesson')}</div></header>`;
}
function scene() {
  return '<div class="scene"><img src="assets/working-shop.webp" alt="Anna takes an order while her employee prepares bubble tea behind the counter."><p class="image-fallback">Anna takes orders. Her employee prepares the tea. The lesson’s figures and explanations are available below.</p></div>';
}
function stages(current) {
  return `<ol class="lesson-stages" aria-label="Lesson stages">${['Sales', 'Costs', 'Promotion', 'Your turn'].map(label => `<li ${label === current ? 'aria-current="step"' : ''}>${label}</li>`).join('')}</ol>`;
}
function understandingCheck(id, prompt, choices) {
  const selected = state.answers[id];
  const choice = choices.find(item => item.value === selected);
  return `<section class="understanding-check ${choice ? 'answered' : 'awaiting-answer'}" aria-label="Reasoning check">
    <p class="check-question">${prompt}</p>
    <div class="check-choices" role="group" aria-label="${escape(prompt)}">${choices.map(item => `<button type="button" class="choice" data-action="answer" data-check="${id}" data-value="${item.value}" aria-pressed="${selected === item.value}">${item.label}</button>`).join('')}</div>
    ${choice ? `<p class="check-feedback" id="check-feedback">${choice.feedback}</p>` : ''}
  </section>`;
}
function frame({ title, stage, question, body, calculation = '', explanation = '',
  detail = '', check = '', next, back, nextTopic, answerKey = '' }) {
  const needsAnswer = answerKey === 'prediction' ? !state.prediction : answerKey ? !state.answers[answerKey] : false;
  return `<div class="shell lesson-shell">${header(title)}${stages(stage)}
    <div class="lesson-layout"><section class="lesson-visual" aria-label="The shop">
      ${scene()}
    </section><section class="teaching-pane" aria-labelledby="teaching-question">
      <h2 id="teaching-question">${question}</h2><p class="teaching-body">${body}</p>
      ${calculation ? `<p class="worked-calculation">${calculation}</p>` : ''}
      ${explanation ? `<div class="concept-explanation">${explanation}</div>` : ''}${detail}${check}
    </section>
    <footer class="lesson-navigation"><div><p class="next-topic">Next: ${nextTopic}</p>${needsAnswer ? '<p id="continue-cue" class="continue-cue">Choose a response to continue.</p>' : ''}</div><nav class="navigation" aria-label="Lesson navigation">${button(back, 'Back')}<button type="button" class="primary" data-action="${next}" ${needsAnswer ? 'disabled aria-describedby="continue-cue"' : ''}>Continue</button></nav></footer>
    </div>
  </div>`;
}
function welcome() {
  const guided = state.mode === 'guided';
  return `<section class="hero home-hero"><div class="hero-copy">
    ${heading('Welcome to<br>Anna’s Tea')}
    <p class="hero-purpose">Learn business analytics by following a shop’s money.</p>
    <p class="hero-explanation">See what comes in, what goes out, and whether a promotion leaves the shop better off.</p>
    <a class="primary" href="#learn">Choose how to learn</a>
  </div></section>
  <section class="home-setup" aria-labelledby="learn"><div class="learning-outcomes">
    <p class="section-eyebrow">One business decision</p>
    <h2 id="learn" tabindex="-1">Would a discount<br>help Anna’s shop?</h2>
    <p class="scenario-invitation">Follow a normal day, see what a promotion changes, then make the call using your own assumptions.</p>
    <p class="learning-route"><span>Follow the money</span><span>Compare the days</span><span>Test your decision</span></p>
  </div><form class="setup-form" id="setup-form" aria-label="Lesson setup">
    <div class="mode" role="group" aria-label="Learning mode"><button type="button" data-action="guided" aria-pressed="${guided}">Guided lesson</button><button type="button" data-action="explore" aria-pressed="${!guided}">Explore</button></div>
    <p class="mode-description">${guided ? 'Follow the lesson, then try your own changes.' : 'Set your normal day, then test a promotion.'}</p>
    <div class="fields"><div class="field"><label for="setup-cups">Cups per day</label>${guided ? '<output id="setup-cups">100</output>' : `<input id="setup-cups" name="cups" type="number" min="${INPUT_LIMITS.cups.min}" max="${INPUT_LIMITS.cups.max}" step="${INPUT_LIMITS.cups.step}" required value="${escape(state.setupDraft.cups)}">`}</div><div class="field"><label for="setup-price">Price per cup</label>${guided ? '<output id="setup-price">$5.00</output>' : `<input id="setup-price" name="price" type="number" min="${INPUT_LIMITS.priceCents.min / 100}" max="${INPUT_LIMITS.priceCents.max / 100}" step="${INPUT_LIMITS.priceCents.step / 100}" required value="${escape(state.setupDraft.price)}">`}</div></div>
    ${costs()}<p class="error" id="setup-error" role="alert"></p>
    <button type="submit" class="primary">${guided ? 'Start lesson' : 'Explore shop'}</button>
  </form></section>`;
}
function guidedScreen() {
  const day = baseline();
  const promo = demonstration();
  const price = money(promo.day.priceCents);
  const extraCups = promo.day.cups - day.cups;
  const extraCupCosts = promo.day.variableCostCents - day.variableCostCents;
  const tenCupMargin = 10 * (day.priceCents - day.costPerCupCents);
  switch (state.screen) {
    case 'normal': return frame({ title: 'A normal day', stage: 'Sales',
      question: 'Follow the money coming in.', body: 'At the register, completed orders become sales.',
      calculation: `${day.cups} cups × ${wholeMoney(day.priceCents)} = ${wholeMoney(day.revenueCents)}`,
      explanation: '<strong>This is revenue.</strong><br>Money from sales, before any costs.',
      check: understandingCheck('revenue', 'Another shop reports more sales revenue. Which shop earned more profit?', [
        { value: 'other', label: 'The other shop', feedback: 'Higher revenue is not enough to decide. We need both shops’ costs before comparing profit.' },
        { value: 'anna', label: 'Anna’s Tea', feedback: 'We cannot tell yet. What each shop keeps depends on its costs as well as its sales.' },
        { value: 'unknown', label: 'Not enough information', feedback: 'We need both shops’ costs. A busier shop can bring in more money and still keep less.' }
      ]), answerKey: 'revenue', next: 'costs', back: 'home', nextTopic: 'what it costs to make and sell the tea.' });
    case 'costs': return frame({ title: 'Where the money goes', stage: 'Costs',
      question: 'What does the shop keep?',
      body: `Ingredients and packaging cost ${wholeMoney(day.costPerCupCents)} per cup: ${day.cups} × ${wholeMoney(day.costPerCupCents)} = ${wholeMoney(day.variableCostCents)}. Base staffing, rent and utilities are set at ${wholeMoney(day.operatingCostCents)} for this example day.`,
      calculation: `${wholeMoney(day.revenueCents)} − (${wholeMoney(day.variableCostCents)} + ${wholeMoney(day.operatingCostCents)}) = ${wholeMoney(day.profitCents)}`,
      explanation: '<strong>This is profit.</strong><br>Revenue minus the costs included here.',
      check: understandingCheck('profit', `At ${wholeMoney(day.priceCents)} per cup and ${wholeMoney(day.costPerCupCents)} cup costs, with no extra staffing, which adds more profit?`, [
        { value: 'cups', label: 'Sell 10 extra cups', feedback: `Ten cups add ${wholeMoney(10 * day.priceCents)} in sales and ${wholeMoney(10 * day.costPerCupCents)} in cup costs: ${wholeMoney(tenCupMargin)} more profit. Cutting operating costs by $20 adds $20. The extra cups win under these assumptions.` },
        { value: 'saving', label: 'Cut daily operating costs by $20', feedback: `The saving adds $20, but ten extra cups add ${wholeMoney(tenCupMargin)} after their ${wholeMoney(10 * day.costPerCupCents)} cup costs. With no extra staffing, the extra cups add more profit.` }
      ]), detail: `<details><summary>Cost breakdown</summary>${ledger(day)}</details>`,
      answerKey: 'profit', next: 'predict', back: 'normal', nextTopic: 'predict what a promotion might change.' });
    case 'predict': return frame({ title: 'Before the promotion', stage: 'Promotion',
      question: 'Will a discount help?',
      body: `A ${PROMOTION.percent}% discount changes the price from ${money(day.priceCents)} to ${price}. Assume ${promo.day.cups} cups sell.`,
      calculation: `${money(day.priceCents)} × ${100 - PROMOTION.percent}% = ${price}`,
      explanation: `Will the shop earn more than its normal ${wholeMoney(day.profitCents)} profit? Turnout is an assumption, not a forecast.`,
      check: `<div class="prediction ${state.prediction ? 'answered' : 'awaiting-answer'}" role="group" aria-label="Your prediction"><button type="button" class="choice" data-action="predict-more" aria-pressed="${state.prediction === 'more'}">More profit</button><button type="button" class="choice" data-action="predict-less" aria-pressed="${state.prediction === 'less'}">Same or less</button></div>${state.prediction ? '<p class="hint">Prediction saved. Continue to compare the outcome.</p>' : ''}`,
      answerKey: 'prediction', next: 'promotion', back: 'costs', nextTopic: 'follow the promotion day.' });
    case 'promotion': return frame({ title: 'The promotion day', stage: 'Promotion',
      question: 'More sales bring more cup costs.', body: 'The discount changes what each customer pays. Ingredients and packaging still cost the same per cup.',
      calculation: `<span class="calculation-label">Sales revenue</span>${promo.day.cups} cups × ${price} = ${wholeMoney(promo.day.revenueCents)}<span class="calculation-label">Ingredients &amp; packaging</span>${promo.day.cups} cups × ${wholeMoney(day.costPerCupCents)} = ${wholeMoney(promo.day.variableCostCents)}`,
      explanation: `On the normal day: ${day.cups} × ${wholeMoney(day.costPerCupCents)} = ${wholeMoney(day.variableCostCents)}. The extra ${extraCups} cups add ${wholeMoney(extraCupCosts)} in costs. Base operating costs remain ${wholeMoney(day.operatingCostCents)}.`,
      next: 'compare', back: 'predict', nextTopic: 'compare the profit after costs.' });
    case 'compare': return frame({ title: 'Did the promotion help?', stage: 'Promotion',
      question: 'Normal day vs promotion.', body: 'This worked example keeps base staffing and operating costs unchanged.',
      calculation: '',
      explanation: `${comparisonTable(day, promo.day)}<p class="incremental-profit"><span class="calculation-label">Extra revenue − extra cup costs</span>${wholeMoney(promo.day.revenueCents - day.revenueCents)} − ${wholeMoney(extraCupCosts)} = ${wholeMoney(promo.differenceCents)} more profit</p>`,
      detail: `${state.prediction ? `<p class="hint">${state.prediction === 'more' ? 'Your prediction matched this example.' : 'The extra sales covered the added costs in this example.'}</p>` : ''}<details><summary>Promotion breakdown</summary>${ledger(promo.day)}</details>`,
      next: 'experiment', back: 'promotion', nextTopic: 'change cups, price, discount and staffing. Run updates the result without replaying the lesson.' });
  }
}
function comparisonTable(normal, promoted) {
  return `<table class="day-comparison"><caption>Daily results</caption><thead><tr><th scope="col">USD per day</th><th scope="col">Normal</th><th scope="col">Promotion</th></tr></thead><tbody>${[['Revenue', 'revenueCents'], ['Total costs', 'totalCostCents'], ['Profit', 'profitCents']].map(([label, key]) => `<tr class="${key === 'profitCents' ? 'profit-row' : ''}"><th scope="row">${label}</th><td>${wholeMoney(normal[key])}</td><td>${wholeMoney(promoted[key])}</td></tr>`).join('')}</tbody></table>`;
}
function comparison(run) {
  return run.comparison === 'same' ? 'Same profit as the normal day.' : `${wholeMoney(Math.abs(run.differenceCents))} ${run.comparison === 'better' ? 'more' : 'less'} than the normal day.`;
}
function outcome(run) {
  return run.outcome === 'break-even' ? 'Break-even' : `${wholeMoney(Math.abs(run.day.profitCents))} ${run.outcome}`;
}
function outcomeLabel(run) {
  return run.outcome === 'profit' ? 'Profitable' : run.outcome === 'loss' ? 'Loss' : 'Break-even';
}
function experiment() {
  const draft = state.drafts[state.mode];
  const run = state.runs[state.mode];
  const dirty = state.dirty[state.mode];
  return `<div class="shell experiment-shell">${header('Try a promotion')}${stages('Your turn')}
    <div class="experiment-layout experiment-stage">${scene()}
    <section class="experiment-pane" aria-label="Promotion experiment"><h2>What would you change?</h2>
    <p class="baseline-reference">Normal day stays at ${state.setup.cups} cups at ${money(state.setup.priceCents)}.</p>
    <form id="experiment-form"><div class="fields">
      <div class="field"><label for="experiment-cups">Cups sold per day</label><input id="experiment-cups" type="number" name="cups" min="${INPUT_LIMITS.cups.min}" max="${INPUT_LIMITS.cups.max}" step="${INPUT_LIMITS.cups.step}" required value="${escape(draft.cups)}" aria-describedby="campaign-hint"></div>
      <div class="field"><label for="experiment-price">Selling price ($)<span class="field-note">Before discount</span></label><input id="experiment-price" type="number" name="price" min="${INPUT_LIMITS.priceCents.min / 100}" max="${INPUT_LIMITS.priceCents.max / 100}" step="${INPUT_LIMITS.priceCents.step / 100}" required value="${escape(draft.price)}" aria-describedby="campaign-hint"></div>
      <div class="field"><label for="experiment-discount">Discount (%)</label><input id="experiment-discount" type="number" name="discount" min="${INPUT_LIMITS.discount.min}" max="${INPUT_LIMITS.discount.max}" step="${INPUT_LIMITS.discount.step}" required value="${escape(draft.discount)}" aria-describedby="discount-preview"></div>
      <div class="field"><label for="experiment-staff">Extra staffing</label><select id="experiment-staff" name="staffing">${STAFF_OPTIONS.map(cents => `<option value="${cents}" ${String(cents) === draft.staffing ? 'selected' : ''}>${wholeMoney(cents)}</option>`).join('')}</select></div>
    </div><p class="hint" id="campaign-hint">Promotion inputs; cups are assumed, not forecast.</p><p class="discount-preview" id="discount-preview">${draftPricePreview(draft)}</p>${costs()}<p id="experiment-error" class="error" role="alert"></p>
    <div class="experiment-actions"><button class="primary" type="submit">Run the day</button>${button('restore', 'Restore promotion')}</div></form>
    <div class="run-result"><p id="run-status" tabindex="-1" class="${dirty ? 'stale' : ''}">${run ? dirty ? 'Inputs changed. Run the day to update the result.' : `${outcomeLabel(run)}. ${comparison(run)}` : 'Run the day to compare results.'}</p>
      ${run && !dirty ? `${comparisonTable(run.baseline, run.day)}<details><summary>Promotion breakdown</summary>${ledger(run.day)}</details>` : ''}
      <button class="primary" type="button" data-action="results" ${!run || dirty ? 'disabled' : ''}>See summary</button>
    </div><div class="result-actions">${button(state.mode === 'guided' ? 'compare' : 'home', 'Back')}${state.mode === 'explore' ? button('restart', 'View lesson') : ''}</div></section></div></div>`;
}
function draftPricePreview(draft) {
  try {
    const { priceCents, promotion } = parsePromotionDraft(draft);
    const price = promotionalPrice(priceCents, promotion);
    return `Price after discount: ${money(price)} (rounded per cup).`;
  } catch { return 'Enter a valid price and whole-number discount.'; }
}
function ending() {
  const run = state.runs[state.mode];
  if (!run || state.dirty[state.mode]) { state.screen = 'experiment'; return experiment(); }
  const monthly = monthlyEstimate(run.day);
  return `<div class="shell summary-shell">${header('Your result')}${stages('Your turn')}
    <section class="summary-ending" aria-label="Completed promotion summary">
      <div class="summary-portrait"><img src="assets/anna-and-teammate.webp" alt="Anna and her teammate welcoming you outside the shop."><p class="image-fallback">Anna and her teammate outside the shop.</p></div>
      <div class="summary-panel"><div class="summary-heading"><p class="outcome ${run.outcome === 'loss' ? 'negative' : run.outcome === 'profit' ? 'positive' : ''}">${outcomeLabel(run)}</p><p>${comparison(run)}</p></div>
      <p class="hint">Normal day: ${run.baseline.cups} cups at ${money(run.baseline.priceCents)}; ${wholeMoney(run.baseline.profitCents)} profit.</p>
      <dl class="scenario-snapshot"><div><dt>Cups sold per day</dt><dd>${run.day.cups}</dd></div><div><dt>Selling price before discount</dt><dd>${money(run.priceBeforeDiscountCents)}</dd></div><div><dt>Discount</dt><dd>${run.promotion.percent}%</dd></div><div><dt>Price charged per cup</dt><dd>${money(run.day.priceCents)}</dd></div></dl>
      <div class="summary-breakdowns"><section aria-labelledby="daily-heading"><h2 id="daily-heading">Daily breakdown</h2>${ledger(run.day, 'Promotion day · USD')}</section><section aria-labelledby="monthly-heading"><h2 id="monthly-heading">Monthly estimate</h2>${ledger(monthly, '26 identical trading days · USD')}</section></div>
      <div class="result-actions">${button('experiment', 'Try again', true)}${button('home', 'Back to welcome')}</div></div>
    </section></div>`;
}
function render(focus = true) {
  document.querySelector('#result-announcement').textContent = '';
  document.body.dataset.screen = state.screen;
  app.innerHTML = state.screen === 'welcome' ? welcome() : state.screen === 'experiment' ? experiment() : state.screen === 'results' ? ending() : guidedScreen();
  for (const img of app.querySelectorAll('.scene img,.summary-portrait img')) {
    const fail = () => img.closest('.scene,.summary-portrait').classList.add('failed');
    img.addEventListener('error', fail);
    if (img.complete && !img.naturalWidth) fail();
  }
  const title = app.querySelector('#main-heading');
  document.title = `Anna’s Tea — ${title?.innerText.replace(/\n/g, ' ') || 'Learn what changes profit'}`;
  if (focus) { title?.focus({ preventScroll: true }); window.scrollTo(0, 0); }
}
app.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const action = target.dataset.action;
  if (action === 'guided' || action === 'explore') { state.mode = action; render(false); app.querySelector(`[data-action="${action}"]`).focus(); return; }
  if (action === 'answer') {
    const check = target.dataset.check;
    const value = target.dataset.value;
    if (!['revenue', 'profit'].includes(check)) return;
    state.answers[check] = value;
    render(false);
    [...app.querySelectorAll('[data-action="answer"]')].find(item => item.dataset.check === check && item.dataset.value === value)?.focus();
    document.querySelector('#result-announcement').textContent = app.querySelector('#check-feedback')?.textContent || '';
    return;
  }
  if (action.startsWith('predict-')) { state.prediction = action === 'predict-more' ? 'more' : 'less'; render(false); app.querySelector(`[data-action="${action}"]`).focus(); return; }
  if (action === 'restart') {
    state.mode = 'guided'; state.setup = GUIDED; state.screen = 'normal'; state.prediction = null; state.answers = {};
    state.drafts.guided = freshDraft(); state.runs.guided = null; state.dirty.guided = true;
  } else if (action === 'restore') {
    state.drafts[state.mode] = freshDraft(state.setup.priceCents); state.dirty[state.mode] = true; render(false); app.querySelector('#experiment-cups').focus(); return;
  } else if (action === 'home') state.screen = 'welcome';
  else if (['normal', 'costs', 'predict', 'promotion', 'compare', 'experiment', 'results'].includes(action)) {
    if (action === 'results' && (!state.runs[state.mode] || state.dirty[state.mode])) return;
    state.screen = action;
  }
  render();
});
app.addEventListener('input', event => {
  if (event.target.closest('#setup-form') && state.mode === 'explore') {
    const form = new FormData(app.querySelector('#setup-form'));
    state.setupDraft = { cups: form.get('cups'), price: form.get('price') };
  }
  if (event.target.closest('#experiment-form')) {
    const form = new FormData(app.querySelector('#experiment-form'));
    state.drafts[state.mode] = { cups: form.get('cups'), staffing: form.get('staffing'), price: form.get('price'), discount: form.get('discount') };
    app.querySelector('#discount-preview').textContent = draftPricePreview(state.drafts[state.mode]);
    state.dirty[state.mode] = true;
    document.querySelector('#result-announcement').textContent = '';
    const status = app.querySelector('#run-status');
    status.textContent = state.runs[state.mode] ? 'Inputs changed. Run the day to update the result.' : 'Run the day to see your result.';
    status.className = 'stale';
    app.querySelector('[data-action="results"]').disabled = true;
    app.querySelector('.run-result details')?.remove();
    app.querySelector('.run-result .day-comparison')?.remove();
  }
});
app.addEventListener('submit', event => {
  event.preventDefault();
  if (!event.target.reportValidity()) return;
  try {
    if (event.target.id === 'setup-form') {
      const setup = state.mode === 'guided' ? GUIDED : validateSetup({ cups: Number(state.setupDraft.cups), priceCents: moneyToCents(state.setupDraft.price) });
      if (state.mode === 'explore') {
        if (setup.cups !== state.exploreReference.cups || setup.priceCents !== state.exploreReference.priceCents) state.drafts.explore = freshDraft(setup.priceCents);
        state.exploreReference = setup;
      }
      state.setup = setup;
      state.prediction = null;
      state.answers = {};
      state.runs[state.mode] = null; state.dirty[state.mode] = true;
      if (state.mode === 'guided') state.drafts.guided = freshDraft();
      state.screen = state.mode === 'guided' ? 'normal' : 'experiment';
      render();
    } else if (event.target.id === 'experiment-form') {
      const draft = state.drafts[state.mode];
      const { inputs, promotion } = parseExperimentDraft(draft);
      state.runs[state.mode] = runPromotion(state.setup, inputs, promotion);
      state.dirty[state.mode] = false;
      render(false);
      document.querySelector('#result-announcement').textContent = `${outcome(state.runs[state.mode])}. ${comparison(state.runs[state.mode])}`;
      app.querySelector('#run-status').focus();
    }
  } catch (error) {
    app.querySelector(event.target.id === 'setup-form' ? '#setup-error' : '#experiment-error').textContent = error.message;
  }
});
render(false);
