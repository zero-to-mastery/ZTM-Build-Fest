// What Help says on each screen (#621, ADR 0021): what the screen is for,
// the two or three things you can do there, and who sees it. One topic per
// page and segment of routes.js (help-content.test.mjs checks every one has
// a topic) and one per major dialog. Written for easy mode and shown in the
// regular layout too. Pure: no DOM.
//
// An action's `show` is a CSS selector for the control it describes; "Show
// me" highlights the first one on screen (app/help.js). An action whose
// control isn't on screen just has no "Show me". An action's `feature` is
// the household feature it needs (web/features.js); while an admin has
// switched that feature off, Help leaves the action out.
import { glossFor, jargonIn } from "./glossary.js";
import { PRIMARY_DESTINATIONS, SEGMENTS, resolveRoute } from "../routes.js";
import { DESTINATION_DESCRIPTIONS, HOUSEHOLD_HUB_LINKS } from "../components/app/constants.js";

/** The words of the Help panel itself. */
export const HELP_COPY = Object.freeze({
  button: "Help",
  heading: (title) => `Help: ${title}`,
  doHeading: "What you can do",
  whoHeading: "Who sees it",
  wordsHeading: "Words on this page",
  showMe: "Show me",
  stuckHeading: "Still stuck?",
  messageAdmin: "Message a household admin",
  report: "Report a problem",
  close: "Close",
  notOnScreen: "That isn't on the screen right now.",
  easyOn: "Easy mode is on. Bigger text and buttons, with fewer things on screen.",
  easyOff: "Easy mode is off.",
});

const EVERYONE = "Everyone in your household.";
const ONLY_YOU = "Only you. Nobody else in your household can see it.";

const action = (text, show = null, feature = null) => Object.freeze({ text, ...(show ? { show } : {}), ...(feature ? { feature } : {}) });
const topic = (title, about, actions, who) => Object.freeze({ title, about, actions: Object.freeze(actions), who });

export const HELP_TOPICS = Object.freeze({
  today: topic("Today",
    "What needs doing today, in one place: your things, things for everyone, and what is planned to eat.",
    [
      action("Write something down in the box at the top and press Add.", "kin-compose input, kin-compose textarea"),
      action("Press Complete when something is done. A line at the bottom lets you undo it.", ".complete-control"),
      action("Open This week to see the next seven days and the calendar.", "a[href=\"#week\"]"),
    ], EVERYONE),
  // The Calendar (#661, #664): one topic per view.
  "week/week": topic("Calendar: Week",
    "Seven days from today: events in each person's colour with their names, things planned, routines and meals.",
    [
      action("Press Add event and write what, when and who.", ".cal-add", "calendar"),
      action("Tick something off when it is done.", ".week-check"),
      action("Move a thing to another day.", ".week-move"),
    ], EVERYONE),
  "week/day": topic("Calendar: Day",
    "One day: all-day events, meals and things planned at the top, then the day hour by hour.",
    [
      action("Press a day in the row of days, or use the arrow keys, to see it.", ".cal-strip-day"),
      action("Press an event to change or cancel it. A line at the bottom lets you undo it.", ".cal-event"),
      action("Press Add event to add one.", ".cal-add"),
    ], EVERYONE),
  "week/month": topic("Calendar: Month",
    "The whole month at a glance: each day shows its events in each person's colour.",
    [
      action("Press a day to see it on its own.", ".cal-month-cell"),
      action("Use Previous and Next to see other months.", ".cal-next"),
      action("Import a calendar file from another app.", ".cal-import"),
    ], EVERYONE),
  // The chore chart (#676, ADR 0022 §6).
  chores: topic("Chore chart",
    "The children's jobs for today and the week, in their colours. Each job ticked off earns points; points start again every Monday.",
    [
      action("Tick the big box when a job is done. Tick it again to undo.", ".chore-box"),
      action("Set a reward, like 20 points for movie night.", ".chore-reward-toggle"),
      action("Adults can join in when a household admin allows it, and leave at any time.", ".chore-join-button"),
    ], EVERYONE),
  foryou: topic("For you",
    "What the family left for you while you look after the home: notes, contacts and what to do.",
    [action("Read the notes from top to bottom; the most important ones come first.", "kin-sitter-page h2")],
    "The family who invited you, and you."),
  search: topic("Search",
    "Find anything in your household: things to do, shopping, notes and messages.",
    [
      action("Type a word or two in the search box.", "kin-search input"),
      action("Press a result to open it where it lives."),
    ], "Only you see what you search for."),
  journal: topic("Journal",
    "Your own diary, with dates and photos.",
    [
      action("Write a new entry and save it.", "kin-journal textarea, kin-journal .primary-action"),
      action("Look back by month, or search your entries.", ".journal-month select, .journal-month input"),
    ], ONLY_YOU),
  "lists/todo": topic("To do",
    "Things that need doing around the home.",
    [
      action("Type a thing in the box and press Add.", "kin-compose input"),
      action("Press Complete when it is done.", ".complete-control"),
      action("Press Details to add a date, a person or a photo.", ".item-details-button"),
    ], EVERYONE),
  "lists/shopping": topic("Shopping",
    "Your household's shopping list.",
    [
      action("Type what you need and press Add.", "kin-compose input"),
      action("Press Complete when it is in the basket.", ".complete-control"),
      action("Press Start shopping in the shop for big buttons and one list.", ".start-shopping"),
    ], EVERYONE),
  "lists/staples": topic("Staples",
    "Things you buy again and again, like milk or bread.",
    [
      action("Add something you buy often.", "kin-compose input"),
      action("Press Add to Shopping when you are running low.", ".replenish-button"),
    ], EVERYONE),
  "lists/meals": topic("Meals",
    "Plan breakfast, lunch, dinner and snacks for the week and keep the recipes you cook.",
    [
      action("Choose a meal for a day.", ".meal-day-actions button"),
      action("Press Same as last week to plan this week like the last one.", ".meals-same-as-last"),
      action("Save a recipe you like. Press its star to keep it in Favourites.", ".recipe-form input, .meals-recipes-head button, .recipe-favourite"),
    ], EVERYONE),
  "lists/mine": topic("Just for me",
    "Your own to-dos and short notes.",
    [
      action("Add something only you need to remember.", "kin-just-for-me input"),
      action("Tick it off when it is done.", ".private-check"),
    ], ONLY_YOU),
  "routines/all": topic("Routines",
    "Things that come round again, like bin night or watering the plants.",
    [
      action("Add a routine and choose how often it happens.", ".routine-form input"),
      action("Press Complete when it is done this time.", ".routine-row .complete-button"),
    ], EVERYONE),
  "routines/checklists": topic("Reusable checklists",
    "Lists of steps you use again and again, like packing for a trip.",
    [
      action("Make a checklist: give it a name and write one step per line.", ".playbook-section input, .playbook-section textarea"),
      action("Use a checklist to turn its steps into things to do."),
    ], EVERYONE),
  "updates/handoffs": topic("Handoffs",
    "Short notes that pass something on to a person, like \"Dog fed at 6\" or \"Parcel is on the porch\".",
    [
      action("Write a note and press Add handoff.", "#handoff-text"),
      action("Press Got it when you have read a note left for you.", ".handoff-row button"),
    ], EVERYONE),
  "updates/chat": topic("Chat",
    "Talk with your household, like text messages.",
    [
      action("Type a message in the box at the bottom and press Send.", "#chat-text"),
      action("Put @ before a name to make sure that person sees it."),
      action("Open To talk about to save a bigger topic for a calm moment.", null, "talk"),
    ], "Everyone in your household who can use Chat."),
  "household/hub": topic("Household",
    "Everything about your household that isn't a list or a message.",
    [
      action("Choose a place below to open it.", ".hub-link"),
      action("Use Search to find anything.", ".more-search-link"),
      action("Make a tablet a kitchen display for the wall.", ".display-setup-start", "display"),
    ], EVERYONE),
  "household/fridge": topic("Fridge",
    "A shared drawing board, like the door of a real fridge.",
    [
      action("Draw with your finger or the mouse.", ".fridge-board"),
      action("Add a magnet with a picture or a word.", ".fridge-add-magnet"),
    ], "Everyone in your household who can use the Fridge."),
  "household/photos": topic("Family photos",
    "Photos for the whole family to enjoy, and a slideshow to play them one after another.",
    [
      action("Press Add photos and choose one or more from this phone or computer.", ".album-add"),
      action("Press a photo to see it bigger. Whoever added it can remove it, and so can a household admin.", ".album-thumb"),
      action("Press Slideshow to play them. Tap the screen to stop.", ".album-slideshow-button"),
    ], EVERYONE),
  "household/notes": topic("Notes & reference",
    "Notes and useful details to keep, like a plumber's number or when the boiler was last serviced.",
    [
      action("Add a note.", "kin-notes input, kin-notes textarea"),
      action("Open a note to read or change it."),
    ], EVERYONE),
  "household/sitter": topic("For the sitter",
    "Choose what a babysitter or guest sees first when they open Kin.",
    [
      action("Pick the notes and contacts to show them.", ".sitter-editor .primary-action, .sitter-available button"),
      action("Look at their page the way they will see it.", ".sitter-preview-link"),
    ], "Household adults choose; the sitter sees only what you pick."),
  "household/areas": topic("Areas & status",
    "Parts of your home, like the kitchen or the car, and the household's mode, such as on holiday.",
    [
      action("Add a part of your home.", ".area-create-form input"),
      action("Change the household's mode when you are away.", "#household-mode"),
      action("Say how you are doing for a few hours with Pulse.", ".pulse-form button"),
    ], EVERYONE),
  "household/people": topic("People & devices",
    "Who is in your household, and the phones and computers that can open it.",
    [
      action("Invite someone or add another phone or computer.", "kin-household button"),
      action("Change the name others see for you."),
    ], "Everyone in your household sees who is in it. Only a household admin can add or remove people."),
  "household/privacy": topic("Privacy & recovery",
    "Keeping Kin safe: locking it, ways to sign in, and a copy you can bring back if a phone is lost.",
    [
      action("Press Lock at the top whenever you step away.", ".header-lock"),
      action("Add a passkey so your face or fingerprint signs you in.", "kin-security button"),
      action("Save a backup so you can always get back in."),
    ], "Only you. These choices are about you and this phone or computer."),
  "household/appearance": topic("Identity & appearance",
    "How Kin looks for you: colors, text size, and easy mode.",
    [
      action("Turn on easy mode for bigger text and buttons, with fewer things on screen.", ".easy-mode-setting input"),
      action("Make the text bigger.", "kin-personal-settings input[type=\"radio\"]"),
      action("Choose your colors.", "kin-appearance button"),
    ], "Only you. A household admin can also set the household's colors for everyone."),
  "household/features": topic("Features",
    "Which parts of Kin your household uses. A part that is switched off is hidden for everyone; nothing in it is deleted.",
    [
      action("Read what each part does.", ".features-item"),
      action("A household admin switches parts on or off and saves.", ".features-switch"),
    ], "Everyone in your household sees the list. Only a household admin can change it."),
  // Kitchen display mode (#670, ADR 0022 §4).
  "dialog:kitchen-display": topic("Kitchen display",
    "A screen for the kitchen wall: today, the week, chores, meals and shopping, for everyone to see and tap.",
    [
      action("Tick a child's job, or something on the shopping list, when it is done.", ".kitchen-display .chore-box, .display-check"),
      action("Set or change a child's reward with the big buttons. Saving it, and Undo, ask for your password or passkey.", ".kitchen-display .chore-reward-toggle"),
      action("Touch the screen to wake it. To leave, press Leave display mode and confirm with your password or passkey.", ".display-leave"),
    ], "Everyone in the kitchen. It never shows anyone's private things or admin settings."),
  "dialog:quick-add": topic("Quick add",
    "Write something down fast, from any page.",
    [
      action("Type what it is.", "#quick-add-title-input"),
      action("Press Add. You can add a date or a person later."),
    ], EVERYONE),
  "dialog:item-detail": topic("Details",
    "Everything about one thing: steps, date, who it is for, photos and a reminder.",
    [
      action("Add a step, a date or a person.", ".item-detail-primary button, .item-detail-primary input"),
      action("Set a reminder so your phone tells you when it is due.", "kin-reminder button"),
      action("Close details when you are finished.", ".item-detail-close"),
    ], EVERYONE),
  "dialog:event-editor": topic("Event",
    "Add an event to the family calendar, or change one.",
    [
      action("Write what it is, choose the day and the time, and who it is for.", "#event-title"),
      action("Open More details for a place, notes, repeats and a countdown.", ".event-more summary"),
      action("Press Save. A line at the bottom lets you undo it.", ".event-save"),
    ], EVERYONE),
  "dialog:calendar-import": topic("Import a calendar file",
    "Bring events from another calendar app into Kin, from an .ics file.",
    [
      action("Choose the file. Kin says how many events it has before saving anything.", ".calendar-import-choose"),
      action("Press Import. Importing the same file again updates the events, never doubles them.", ".calendar-import-confirm"),
    ], EVERYONE),
  "dialog:shopping-mode": topic("Shopping mode",
    "Your shopping list made big, for use in the shop.",
    [
      action("Tap a thing when it is in your basket.", ".shopping-mode-item"),
      action("Press Done shopping when you are finished.", ".shopping-mode-done"),
    ], EVERYONE),
});

/** The key Help uses for a route ({ page, segment }) or a dialog key. */
export function helpKey(route) {
  if (typeof route === "string") return route;
  if (!route?.page) return "today";
  return route.segment ? `${route.page}/${route.segment}` : route.page;
}

/**
 * The fixed words a screen shows besides its records: the navigation, the
 * page's heading and line, its tabs and, on the Household overview, its
 * links. Help glosses the harder ones (never the household's own words).
 */
export function screenText(key) {
  if (String(key).startsWith("dialog:")) return PRIMARY_DESTINATIONS.map((entry) => entry.label);
  const route = resolveRoute({ hash: `#${key}` });
  const text = PRIMARY_DESTINATIONS.map((entry) => entry.label);
  text.push(route.title);
  if (DESTINATION_DESCRIPTIONS[route.page]) text.push(DESTINATION_DESCRIPTIONS[route.page]);
  if (route.page === "updates") text.push(DESTINATION_DESCRIPTIONS.updatesWithoutChat);
  for (const entry of SEGMENTS[route.page] ?? []) text.push(entry.label);
  if (route.canonical === "household/hub") for (const [, line] of HOUSEHOLD_HUB_LINKS) text.push(line);
  return text;
}

/**
 * The topic for `key` (a route key or "dialog:…"), with `words`: the
 * glossary entries for every harder word on that screen — in the topic
 * itself and in `screenText` (what the screen shows, such as its heading,
 * line and tab names). Falls back to the page's first topic, then Today.
 */
export function helpTopic(key, extraText = screenText(key)) {
  const [page] = String(key ?? "").split("/");
  const found = HELP_TOPICS[key] ??
    Object.entries(HELP_TOPICS).find(([candidate]) => candidate.split("/")[0] === page)?.[1] ??
    HELP_TOPICS.today;
  const text = [found.title, found.about, found.who, ...found.actions.map((entry) => entry.text), HELP_COPY.messageAdmin, ...extraText].join("\n");
  return { ...found, key: HELP_TOPICS[key] ? key : null, words: glossFor(jargonIn(text)) };
}
