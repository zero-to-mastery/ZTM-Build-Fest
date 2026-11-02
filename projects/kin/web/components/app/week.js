// This week (#416), now the Calendar's Week view (#661): reads the week
// from Rust while it is showing and hands it to <kin-week>, with each day's
// calendar events (app/calendar.js) while the Calendar is switched on.
// State stays on the element (`this.app`); app/context.js explains the
// controllers.
import { filterWeekDays } from "../../features.js";
import { mergeMealsIntoWeek } from "../../meals/meals-view.js";

export class WeekController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.reading = null;
    this.again = false;
  }

  /** Reads and draws the week when the Week view is showing. Reads
   * coalesce: one in flight, at most one more after it. */
  async refresh() {
    if (this.app.route?.page !== "week" || (this.app.route.segment && this.app.route.segment !== "week") || !this.app.week || !this.app.store || !this.app.state) return;
    if (this.reading) { this.again = true; return this.reading; }
    const session = this.ctx.session.captureSession();
    this.reading = (async () => {
      try {
        const today = this.ctx.navigation.currentCivilDate();
        // Weeks run from today in steps of seven (calendar-time.js).
        const start = this.ctx.calendar?.weekStart?.() ?? today;
        const days = await session.store.week(start);
        // The calendar's events by day; none with the Calendar off.
        const calendar = await this.ctx.calendar?.weekEvents?.(start).catch(() => null) ?? null;
        if (!this.ctx.session.isCurrentSession(session) || !this.app.week) return;
        // Breakfast, lunch and snacks (#679) join Rust's dinners from the
        // meals view; rows of switched-off features then leave the week
        // (#625).
        const withMeals = mergeMealsIntoWeek(days, this.app.mealsState);
        this.app.week.update({
          days: filterWeekDays(withMeals, this.ctx.features.off), today, state: this.app.state,
          context: this.ctx.detail.responsibilityContext(), privateItems: this.ctx.privateItems.todayItems(),
          events: calendar?.events ?? null, people: calendar?.people ?? null,
        });
        this.app.calendar?.update({ days: calendar?.events, loading: false });
      } catch {
        // The page keeps what it showed; the next render tries again.
      } finally {
        this.reading = null;
        if (this.again) { this.again = false; void this.refresh(); }
      }
    })();
    return this.reading;
  }
}
