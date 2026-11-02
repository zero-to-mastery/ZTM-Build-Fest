// Building the destination pages and their components.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { routeHash, SEGMENTS } from "../../routes.js";
import { DESTINATION_DESCRIPTIONS, HOUSEHOLD_HUB_LINKS } from "./constants.js";
import { currentPlatform, installHelp } from "../../platform.js";
import { installHelpCard } from "../shared/dom.js";

export class ViewBuilder {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  buildViews(main) {
    const page = (id, title, description = null) => {
      const section = document.createElement("section");
      section.className = "app-view";
      section.id = id;
      section.dataset.page = id;
      section.setAttribute("aria-labelledby", `${id}-title`);
      const intro = document.createElement("header");
      intro.className = "page-intro";
      const heading = document.createElement("h1");
      heading.id = `${id}-title`;
      heading.tabIndex = -1;
      heading.textContent = title;
      // Help on every page (#621), beside the heading.
      intro.append(heading, this.ctx.help.button());
      if (description) {
        const supporting = document.createElement("p");
        supporting.className = "page-lead";
        supporting.textContent = description;
        intro.append(supporting);
      }
      section.append(intro);
      return section;
    };
    const segmentNav = (pageId, label) => {
      const nav = document.createElement("kin-segment-nav");
      nav.setAttribute("label", label);
      // Segments of switched-off features (#625) aren't offered.
      nav.segments = this.ctx.features.segmentEntries(pageId);
      return nav;
    };
    this.app.pages = new Map();
    this.app.segmentNavs = new Map();
    this.app.segmentPanels = new Map();

    // Today: a practical heading (the date), the capture field, catch-up, the
    // onboarding card while it applies, and the composition.
    const today = page("today", "Today", "See what needs doing, or add something for your household to remember.");
    this.app.todayDate = document.createElement("p");
    this.app.todayDate.className = "page-lead today-date";
    // A gentle way to the family fridge (#317), beside the date.
    const fridgeLink = document.createElement("a");
    fridgeLink.className = "today-fridge-link";
    fridgeLink.href = routeHash("household", "fridge");
    fridgeLink.textContent = "Draw on the fridge";
    // Links into a feature leave with it (#625, app/features.js).
    fridgeLink.dataset.featureRoute = "household/fridge";
    // This week (#416): the next seven days in one list.
    const weekLink = document.createElement("a");
    weekLink.className = "today-week-link";
    weekLink.href = "#week";
    weekLink.textContent = "This week";
    weekLink.dataset.featureRoute = "week";
    // The chore chart (#676): the children's jobs, points and rewards.
    const choresLink = document.createElement("a");
    choresLink.className = "today-chores-link";
    choresLink.href = "#chores";
    choresLink.textContent = "Chore chart";
    choresLink.dataset.featureRoute = "chores";
    today.querySelector(".page-intro").append(this.app.todayDate, weekLink, choresLink, fridgeLink);
    this.app.compose.setAttribute("mode", "today");
    this.app.compose.setAttribute("scope", "today");
    this.app.catchUp.setAttribute("aria-label", "Catch up since you last looked");
    this.app.today.display = "today";
    this.app.today.previews = this.app.previewProvider;
    this.app.onboarding = document.createElement("section");
    this.app.onboarding.className = "today-section onboarding-card";
    this.app.onboarding.hidden = true;
    // Tonight's dinner is Meals' (#625).
    this.app.tonight.dataset.feature = "meals";
    // The calm one-time note when the household switches something off
    // (#625, ADR 0021). app/features.js fills and shows it.
    this.app.featuresNote = document.createElement("section");
    this.app.featuresNote.className = "today-section features-note";
    this.app.featuresNote.setAttribute("aria-label", "Changes to Kin");
    this.app.featuresNote.hidden = true;
    const featuresNoteText = document.createElement("p");
    featuresNoteText.className = "features-note-text";
    const featuresNoteOk = document.createElement("button");
    featuresNoteOk.type = "button";
    featuresNoteOk.className = "features-note-ok";
    featuresNoteOk.textContent = "OK";
    featuresNoteOk.addEventListener("click", () => this.ctx.features.dismissNote());
    this.app.featuresNote.append(featuresNoteText, featuresNoteOk);
    // The first week's tips (#617, #622): one calm card at a time.
    this.app.todayTip = document.createElement("section");
    this.app.todayTip.className = "today-section today-tip";
    this.app.todayTip.hidden = true;
    // Today's events and the next countdown (#663); the Calendar's.
    this.app.calendarToday = document.createElement("kin-calendar-today");
    this.app.calendarToday.dataset.feature = "calendar";
    today.append(this.app.featuresNote, this.app.compose, this.app.tonight, this.app.calendarToday, this.app.catchUp, this.app.onboarding, this.app.today, this.app.todayTip);

    // Lists: one list at a time, each with its own quick-add; export lives in
    // the list actions with its warning at the point of use.
    const lists = page("lists", "Lists", DESTINATION_DESCRIPTIONS.lists);
    const listsNav = segmentNav("lists", "Lists");
    this.app.segmentNavs.set("lists", listsNav);
    lists.append(listsNav);
    const listActions = document.createElement("details");
    listActions.className = "list-actions";
    const listActionsSummary = document.createElement("summary");
    listActionsSummary.textContent = "List actions";
    this.app.calendarExportButton = document.createElement("button");
    this.app.calendarExportButton.type = "button";
    this.app.calendarExportButton.className = "calendar-export-button";
    this.app.calendarExportButton.textContent = "Download calendar (.ics)";
    this.app.calendarExportButton.setAttribute("aria-label", "Download active planned Items as an all-day calendar");
    this.app.calendarExportButton.disabled = true;
    this.app.calendarExportButton.addEventListener("click", () => this.ctx.records.downloadCalendar());
    const calendarExportNote = document.createElement("p");
    calendarExportNote.className = "section-hint";
    calendarExportNote.textContent = "Exports every open item that has a planned date, from all lists. The downloaded .ics file is not encrypted and contains the item text.";
    // Bring a list into Kin (#452): paste a list or choose a CSV/text file.
    const importButton = document.createElement("button");
    importButton.type = "button";
    importButton.className = "import-list-button";
    importButton.textContent = "Import a list…";
    importButton.addEventListener("click", () => this.ctx.importList.open({ opener: importButton }));
    const importNote = document.createElement("p");
    importNote.className = "section-hint";
    importNote.textContent = "Paste a list or choose a CSV or text file from another app. It is read on this device; you choose what to add.";
    listActions.append(listActionsSummary, this.app.calendarExportButton, calendarExportNote, importButton, importNote);
    lists.append(listActions);
    this.app.needs.display = "need";
    this.app.shopping.display = "shopping";
    this.app.staples.display = "staple";
    const listPanels = new Map([["todo", this.app.needs], ["shopping", this.app.shopping], ["staples", this.app.staples]]);
    for (const [segment, list] of listPanels) {
      list.previews = this.app.previewProvider;
      list.dataset.segment = segment;
      lists.append(list);
    }
    this.app.meals.dataset.segment = "meals";
    lists.append(this.app.meals);
    listPanels.set("meals", this.app.meals);
    // Just for me (#510): built with the views, so a lock drops it and
    // everything it showed.
    this.app.justForMe = document.createElement("kin-just-for-me");
    this.app.justForMe.dataset.segment = "mine";
    this.app.justForMe.controller = this.ctx.privateItems;
    lists.append(this.app.justForMe);
    listPanels.set("mine", this.app.justForMe);
    this.ctx.privateItems.refresh();
    this.app.segmentPanels.set("lists", listPanels);

    const search = page("search", "Search");
    search.append(this.app.search);
    // The Calendar (#661, ADR 0022 §2): This week grown into Day, Week and
    // Month views; the views are the page's segments.
    const week = page("week", "Calendar", DESTINATION_DESCRIPTIONS.week);
    const weekNav = segmentNav("week", "Calendar views");
    this.app.segmentNavs.set("week", weekNav);
    this.app.week = document.createElement("kin-week");
    this.app.calendar = document.createElement("kin-calendar");
    this.app.calendar.weekList = this.app.week;
    week.append(weekNav, this.app.calendar);
    const chores = this.buildChoresPage(page);

    const routines = page("routines", "Routines", DESTINATION_DESCRIPTIONS.routines);
    const routinesNav = segmentNav("routines", "Routines");
    this.app.segmentNavs.set("routines", routinesNav);
    routines.append(routinesNav, this.app.routines);

    const updates = page("updates", "Updates", DESTINATION_DESCRIPTIONS.updates);
    // Kept so the line can drop Chat when the chat policy removes it.
    this.app.updatesLead = updates.querySelector(".page-lead");
    const updatesNav = segmentNav("updates", "Updates");
    this.app.segmentNavs.set("updates", updatesNav);
    const handoffPanel = document.createElement("section");
    handoffPanel.id = "handoffs-panel";
    handoffPanel.setAttribute("aria-label", "Handoffs");
    const chatPanel = document.createElement("section");
    chatPanel.id = "chat-panel";
    chatPanel.setAttribute("aria-label", "Chat");
    handoffPanel.append(this.app.handoffs);
    // To talk about (#312, ADR 0014): the older Talk topics live in Chat's
    // list; without chat access, in their own section under Handoffs.
    this.app.talksStandalone = document.createElement("section");
    this.app.talksStandalone.id = "talk-standalone";
    this.app.talksStandalone.className = "talk-standalone";
    this.app.talksStandalone.hidden = true;
    this.app.talksStandalone.dataset.feature = "talk";
    handoffPanel.append(this.app.talksStandalone);
    chatPanel.append(this.app.chat);
    this.ctx.views.placeTalks();
    // The unread count (#133) from the chat view: on the Chat link and, if
    // the member chose it (#476), on the installed app's icon. Both are set
    // from what this device decrypted; no count is sent anywhere.
    this.app.chat.addEventListener("kin:chat-unread", (event) => {
      this.app.chatUnread = event.detail;
      this.ctx.render.renderUpdatesNav();
      this.ctx.badge.update();
    });
    // The admin's chat policy (#123): with no access, Chat leaves Updates.
    this.app.chat.addEventListener("kin:chat-access", (event) => {
      this.app.chatAccess = event.detail.access;
      this.ctx.views.placeTalks();
      this.ctx.render.renderState();
      if (event.detail.access === "none" && this.app.route?.page === "updates" && this.app.route.segment === "chat")
        this.ctx.navigation.navigate(routeHash("updates", "handoffs"));
    });
    updates.append(updatesNav, handoffPanel, chatPanel);
    this.app.segmentPanels.set("updates", new Map([["handoffs", handoffPanel], ["chat", chatPanel]]));

    // Household: an overview plus secondary destinations. Appearance remains
    // personal while the five primary destinations stay unchanged.
    const household = page("household", "Household", DESTINATION_DESCRIPTIONS.household);
    const householdNav = segmentNav("household", "Household");
    this.app.segmentNavs.set("household", householdNav);
    household.append(householdNav);
    const hub = document.createElement("section");
    hub.className = "household-hub";
    hub.setAttribute("aria-label", "Household overview");
    this.app.householdGlance = document.createElement("p");
    this.app.householdGlance.className = "household-glance";
    const hubLinks = document.createElement("ul");
    hubLinks.className = "hub-links";
    for (const [segment, description] of HOUSEHOLD_HUB_LINKS) {
      const entry = SEGMENTS.household.find((candidate) => candidate.id === segment);
      const item = document.createElement("li");
      item.dataset.featureRoute = `household/${segment}`;
      const link = document.createElement("a");
      link.className = "hub-link";
      link.href = routeHash("household", segment);
      const name = document.createElement("span");
      name.className = "hub-link-name";
      name.textContent = entry.label;
      const text = document.createElement("span");
      text.className = "hub-link-text";
      text.textContent = description;
      link.append(name, text);
      item.append(link);
      hubLinks.append(item);
    }
    // Easy mode tucks Routines away from the navigation until it is used
    // (#617); it stays one tap away here.
    {
      const item = document.createElement("li");
      item.className = "easy-only";
      // Hidden with Routines when an admin switches it off (ADR 0021 §2).
      item.dataset.feature = "routines";
      const link = document.createElement("a");
      link.className = "hub-link";
      link.href = routeHash("routines");
      const name = document.createElement("span");
      name.className = "hub-link-name";
      name.textContent = "Routines";
      const text = document.createElement("span");
      text.className = "hub-link-text";
      text.textContent = DESTINATION_DESCRIPTIONS.routines;
      link.append(name, text);
      item.append(link);
      hubLinks.append(item);
    }
    // Just for you (#497, ADR 0019): private pages, apart from the
    // household's. The journal is a page of its own, not a destination.
    const personalHeading = document.createElement("h2");
    personalHeading.className = "hub-personal-heading";
    personalHeading.id = "hub-personal-heading";
    personalHeading.textContent = "Just for you";
    // The journal is all that's here; it leaves with its feature (#625).
    personalHeading.dataset.featureRoute = "journal";
    const personalLinks = document.createElement("ul");
    personalLinks.className = "hub-links hub-personal";
    personalLinks.setAttribute("aria-labelledby", personalHeading.id);
    personalLinks.dataset.featureRoute = "journal";
    {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.className = "hub-link journal-hub-link";
      link.href = "#journal";
      const name = document.createElement("span");
      name.className = "hub-link-name";
      name.textContent = "Journal";
      const text = document.createElement("span");
      text.className = "hub-link-text";
      text.textContent = "Your own dated entries and photos. Only you can see them.";
      link.append(name, text);
      item.append(link);
      personalLinks.append(item);
    }
    hub.append(this.app.householdGlance, hubLinks, personalHeading, personalLinks);
    // Kitchen display mode (#670): Adults make this device a wall screen.
    this.app.displaySetup = document.createElement("kin-display-setup");
    this.app.displaySetup.dataset.feature = "display";
    hub.append(this.app.displaySetup);
    this.ctx.display?.renderSetup();
    const hubTools = document.createElement("div");
    hubTools.className = "hub-tools";
    this.app.installButton = document.createElement("button");
    this.app.installButton.type = "button";
    this.app.installButton.textContent = "Install Kin";
    this.app.installButton.hidden = true;
    this.app.installButton.addEventListener("click", async () => {
      const prompt = this.app.deferredInstallPrompt;
      if (!prompt) return;
      this.app.deferredInstallPrompt = null;
      this.app.installButton.hidden = true;
      await prompt.prompt();
      await prompt.userChoice;
    });
    if (this.app.deferredInstallPrompt) this.app.installButton.hidden = false;
    const searchLink = document.createElement("a");
    searchLink.className = "more-search-link";
    searchLink.href = "#search";
    searchLink.textContent = "Search household";
    hubTools.append(searchLink, this.app.installButton);
    // Telling the Kin team (ADR 0021 §3): a problem from anyone, and what
    // this member has sent with its status.
    const reportTools = document.createElement("div");
    reportTools.className = "hub-report-tools";
    const reportProblem = document.createElement("button");
    reportProblem.type = "button";
    reportProblem.className = "secondary hub-report-problem";
    reportProblem.textContent = "Report a problem";
    reportProblem.addEventListener("click", () => this.ctx.report.open("problem", { opener: reportProblem }));
    const sentLink = document.createElement("button");
    sentLink.type = "button";
    sentLink.className = "secondary hub-feedback-sent";
    sentLink.textContent = "What I've sent";
    sentLink.addEventListener("click", () => this.ctx.report.open("sent", { opener: sentLink }));
    reportTools.append(reportProblem, sentLink);
    hubTools.append(reportTools);
    // iPhone and iPad browsers have no install prompt; show the steps instead.
    const iosInstall = installHelp(currentPlatform());
    if (iosInstall) {
      const disclosure = document.createElement("details");
      disclosure.className = "install-disclosure";
      const summary = document.createElement("summary");
      summary.textContent = "Install Kin";
      disclosure.append(summary);
      installHelpCard(iosInstall, { parent: disclosure });
      hubTools.append(disclosure);
    }
    hub.append(hubTools);

    // The family fridge (#317): its board room arrives from the sync
    // coordinator once this device's keys are ready.
    const fridgePage = document.createElement("section");
    fridgePage.className = "household-subpage fridge-page";
    fridgePage.setAttribute("aria-label", "Fridge");
    this.app.fridge = document.createElement("kin-fridge");
    fridgePage.append(this.app.fridge);

    const notesPage = document.createElement("section");
    notesPage.className = "household-subpage";
    notesPage.setAttribute("aria-label", "Notes & reference");
    this.app.notes = document.createElement("kin-notes");
    this.app.notes.previews = this.app.previewProvider;
    notesPage.append(this.app.notes);

    const areasPage = document.createElement("section");
    areasPage.className = "household-subpage";
    areasPage.setAttribute("aria-label", "Areas & status");
    const modeSection = document.createElement("section");
    modeSection.className = "today-section household-mode";
    const modeHeading = document.createElement("h2");
    modeHeading.textContent = "Household mode";
    const modeLabel = document.createElement("label");
    modeLabel.htmlFor = "household-mode";
    modeLabel.textContent = "Current mode";
    this.app.modeSelect = document.createElement("select");
    this.app.modeSelect.id = "household-mode";
    for (const [value, label] of [
      ["normal", "Normal"],
      ["vacation", "Vacation"],
      ["guests", "Guests"],
      ["rest", "Rest"],
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      this.app.modeSelect.append(option);
    }
    this.app.modeSelect.addEventListener("change", this.app.onModeChange);
    const modeHint = document.createElement("p");
    modeHint.className = "section-hint";
    modeHint.textContent = "Routines pause while the household is in Vacation, Guests, or Rest; their definitions stay as they are. Nothing else changes: lists, handoffs, and access are unaffected, and Guests does not add a member.";
    modeSection.append(modeHeading, modeLabel, this.app.modeSelect, modeHint);
    areasPage.append(this.app.areas, modeSection, this.app.pulse);

    const peoplePage = document.createElement("section");
    peoplePage.className = "household-subpage";
    peoplePage.setAttribute("aria-label", "People & devices");
    this.app.household = document.createElement("kin-household");
    // People & devices reads and sets device names through the app, which
    // owns the household history and its engine (#71).
    this.app.household.deviceNames = {
      load: () => this.ctx.sync.deviceNames(),
      rename: (deviceId, nickname) => this.ctx.sync.renameDevice(deviceId, nickname),
    };
    // Preferred member names (#224, #225) arrive through the seam People &
    // devices already reads: [{ memberId, preferredName }]. A member can only
    // set their own.
    this.app.household.memberNames = {
      load: async () => (await this.ctx.sync.memberNames())
        .map(({ memberId, name }) => ({ memberId, preferredName: name })),
      rename: (name) => this.ctx.sync.setMyName(name),
    };
    this.app.peoplePage = peoplePage;
    // Per-device notification settings (#85), shown once this browser is a
    // trusted household device.
    this.app.notifications = document.createElement("kin-notifications");
    // The count on the app icon (#476): this device's choice, under it.
    this.app.appBadge = document.createElement("kin-app-badge");
    // Read receipts and typing (#120): per member, so shown with the room.
    this.app.chatSettings = document.createElement("kin-chat-settings");
    this.app.chatSettings.hidden = true;

    const privacyPage = document.createElement("section");
    privacyPage.className = "household-subpage";
    privacyPage.setAttribute("aria-label", "Privacy & recovery");
    const privacyLead = document.createElement("p");
    privacyLead.className = "section-hint";
    privacyLead.textContent = "Your household is encrypted on this device. Lock Kin whenever you step away; closing the tab always locks it.";
    // The public privacy policy (#541), in a new tab so this one stays
    // unlocked; the service worker keeps it for offline reading.
    const policy = document.createElement("p");
    policy.className = "section-hint privacy-policy-link";
    const policyLink = Object.assign(document.createElement("a"), {
      href: "/privacy.html", target: "_blank", rel: "noopener", textContent: "Read Kin's privacy policy",
    });
    policy.append(policyLink, " — what stays on your devices, what Kin's service stores and sees, and how to delete it.");
    privacyPage.append(privacyLead, policy);
    this.app.privacyPage = privacyPage;
    // Kept for callers that still address the former More security block.
    this.app.moreSecurity = privacyPage;

    const appearancePage = document.createElement("section");
    appearancePage.className = "household-subpage appearance-page";
    appearancePage.setAttribute("aria-label", "Personal appearance");
    this.app.appearance = document.createElement("kin-appearance");
    this.app.householdDefaults = document.createElement("kin-household-defaults");
    this.app.householdDefaults.hidden = true;
    this.app.chatPolicy = document.createElement("kin-chat-policy");
    // Who can use the fridge (#323), beside who can chat.
    this.app.boardPolicy = document.createElement("kin-board-policy");
    // Text size, motion and reminder alerts, and where they live (#524).
    this.app.personalSettings = document.createElement("kin-personal-settings");
    this.app.personalSettings.update(this.ctx.privatePrefs.settingsView());
    // Suggest something (#628, ADR 0021 §3): household admins only, shown
    // once the household settings say so, under Household › Features.
    this.app.suggestSection = document.createElement("section");
    this.app.suggestSection.className = "today-section suggest-section";
    this.app.suggestSection.setAttribute("aria-labelledby", "suggest-heading");
    this.app.suggestSection.hidden = !this.app.householdAdmin;
    const suggestHeading = document.createElement("h2");
    suggestHeading.id = "suggest-heading";
    suggestHeading.textContent = "Ideas for Kin";
    const suggestHint = document.createElement("p");
    suggestHint.className = "section-hint";
    suggestHint.textContent = "As a household admin, you can suggest something you'd like Kin to do. The Kin team sees it, and you can follow what happens in What I've sent.";
    const suggestButton = document.createElement("button");
    suggestButton.type = "button";
    suggestButton.className = "suggest-button";
    suggestButton.textContent = "Suggest something";
    suggestButton.addEventListener("click", () => this.ctx.report.open("suggestion", { opener: suggestButton }));
    const suggestSent = document.createElement("button");
    suggestSent.type = "button";
    suggestSent.className = "secondary";
    suggestSent.textContent = "What I've sent";
    suggestSent.addEventListener("click", () => this.ctx.report.open("sent", { opener: suggestSent }));
    this.app.suggestSection.append(suggestHeading, suggestHint, suggestButton, suggestSent);
    // My calendar colour (#663): the Calendar's.
    this.app.memberColour = document.createElement("kin-member-colour");
    this.app.memberColour.dataset.feature = "calendar";
    // Outside calendars (#668, ADR 0022 §3): Google, Apple or Outlook
    // calendars synced through the household's Kin server. They show in the
    // Calendar, so they leave with its switch (bit 14).
    this.app.calendarSubscriptions = document.createElement("kin-calendar-subscriptions");
    this.app.calendarSubscriptions.dataset.feature = "calendar";
    this.app.calendarSubscriptions.controller = this.ctx.calendarSync;
    this.app.calendarSubscriptions.update(this.ctx.calendarSync.view());
    appearancePage.append(this.app.householdDefaults, this.app.chatPolicy, this.app.boardPolicy, this.app.appearance, this.app.memberColour, this.app.personalSettings, this.app.calendarSubscriptions);

    // Family photos (#673, ADR 0022 §5).
    const photosPage = document.createElement("section");
    photosPage.className = "household-subpage photos-page";
    photosPage.setAttribute("aria-label", "Family photos");
    this.app.albumView = document.createElement("kin-album");
    this.app.albumView.controller = this.ctx.album;
    photosPage.append(this.app.albumView);
    // For the sitter (#441, ADR 0017).
    const sitterPage = document.createElement("section");
    sitterPage.className = "household-subpage sitter-page";
    sitterPage.setAttribute("aria-label", "For the sitter");
    this.app.sitterEditor = document.createElement("kin-sitter-editor");
    sitterPage.append(this.app.sitterEditor);
    // Household features (#626, ADR 0021): a list with switches for admins,
    // read-only for everyone else.
    const featuresPage = document.createElement("section");
    featuresPage.className = "household-subpage features-page";
    featuresPage.setAttribute("aria-label", "Features");
    this.app.householdFeatures = document.createElement("kin-household-features");
    this.app.householdFeatures.controller = this.ctx.features;
    // Whether adults may join the chore chart (#676): an admin's switch.
    this.app.choreAdults = document.createElement("kin-chore-adults");
    this.app.choreAdults.controller = this.ctx.chores;
    featuresPage.append(this.app.householdFeatures, this.app.choreAdults, this.app.suggestSection);
    household.append(hub, fridgePage, photosPage, notesPage, sitterPage, areasPage, peoplePage, privacyPage, appearancePage, featuresPage);
    this.app.segmentPanels.set("household", new Map([["hub", hub], ["fridge", fridgePage], ["photos", photosPage], ["notes", notesPage], ["sitter", sitterPage], ["areas", areasPage], ["people", peoplePage], ["privacy", privacyPage], ["appearance", appearancePage], ["features", featuresPage]]));

    // For you (#441): the page a Temporary member lands on.
    const foryou = page("foryou", "For you", "What the family left for you.");
    this.app.sitterView = document.createElement("kin-sitter-page");
    foryou.append(this.app.sitterView);
    // A member's journal (#497): private, reached from Household.
    const journal = page("journal", "Journal", "Your own record of your days, on your own devices.");
    this.app.journal = document.createElement("kin-journal");
    journal.append(this.app.journal);
    for (const section of [today, week, chores, foryou, lists, search, routines, updates, household, journal]) {
      this.app.pages.set(section.id, section);
      main.append(section);
    }
    // The conditional side/inline column for item details.
    this.app.detailPanel = document.createElement("aside");
    this.app.detailPanel.className = "detail-panel";
    this.app.detailPanel.setAttribute("aria-label", "Item details");
    this.app.detailPanel.hidden = true;
    main.append(this.app.detailPanel);
    this.ctx.journal?.render();
    this.ctx.navigation.showPageFromLocation();
    this.ctx.easy?.updateNavigation();
  }

  /** The chore chart page (#676): the chart, and for an Adult, Join or
   * Leave. Simple view builds its own page around the same chart
   * (app/simple.js). `page` is buildViews' page maker. */
  buildChoresPage(page) {
    const section = page("chores", "Chore chart", "Everyone's jobs for today and the week. Tick them off to earn points; points start again every Monday.");
    section.append(this.choreChartElement());
    const join = document.createElement("section");
    join.className = "today-section chore-join";
    join.setAttribute("aria-label", "You and the chore chart");
    join.hidden = true;
    const hint = document.createElement("p");
    hint.className = "section-hint chore-join-hint";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary chore-join-button";
    button.addEventListener("click", () => void this.ctx.chores.setJoined(!this.ctx.chores.joined));
    join.append(hint, button);
    this.app.choreJoin = join;
    section.append(join);
    return section;
  }

  /** A fresh <kin-chore-chart> wired to the chores controller. */
  choreChartElement() {
    const chart = document.createElement("kin-chore-chart");
    chart.previews = this.app.previewProvider;
    chart.addEventListener("kin:chore-toggle", (event) => void this.ctx.chores.toggle(event.detail));
    chart.addEventListener("kin:chore-reward", (event) => void this.ctx.chores.setReward(event.detail));
    this.app.choreChart = chart;
    return chart;
  }

  /** Shows "Suggest something" to a household admin only. */
  showSuggest(admin) {
    this.app.householdAdmin = admin;
    if (this.app.suggestSection) this.app.suggestSection.hidden = !admin;
  }

  /** Where the older Talk topics show: in Chat's To talk about list, or,
   * without chat access, in a section of their own under Handoffs. */
  placeTalks() {
    const talks = this.app.talks;
    const host = this.app.talksStandalone;
    if (!talks || !host) return;
    const standalone = this.app.chatAccess === "none";
    if (standalone) {
      talks.setAttribute("heading", "To talk about");
      if (talks.parentElement !== host) host.append(talks);
      this.app.chat.legacyTopics = null;
    } else {
      talks.setAttribute("heading", "Other topics");
      this.app.chat.legacyTopics = talks;
      if (talks.parentElement === host) talks.remove();
      if (this.app.chat.legacyHost && talks.parentElement !== this.app.chat.legacyHost) this.app.chat.legacyHost.append(talks);
    }
    host.hidden = !standalone;
  }
}
