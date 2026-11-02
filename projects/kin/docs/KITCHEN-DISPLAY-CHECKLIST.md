# Kitchen display: wall-tablet checklist (#672)

The browser regression (`scripts/kitchen-display-regression.mjs`) checks the
kitchen display at tablet sizes in headless Chromium. Some things only a real
tablet on a real wall can show. This is the owner's check before a release
that changes the display; note the device, browser and Kin version, and file
an issue for anything that fails.

## Before you start

- A 10-inch or larger tablet (Android with Chrome, or an iPad with Safari),
  charging, mounted or propped where it will live, 2–3 m from where people
  stand.
- Kin installed from the home screen (or a browser tab), signed in as an
  Adult, in a household with: an event today and one later this week, a child
  with a chore today, tonight's dinner, three things on Shopping, something
  on the fridge, a few chat messages and a few family photos.
- Note the tablet's own screen timeout and battery saver settings.

## Setting up

- [ ] Household › Overview shows **Kitchen display** with what it shows and
      never shows, and that leaving needs your password or passkey.
- [ ] A Limited member's device says only an adult's device can be one.
- [ ] Choose night hours and quiet minutes, then **Use this device as a
      kitchen display**: the display opens with no header or navigation.

## On the wall

- [ ] From 2–3 m, the time, date, today's events, the chart, dinner and the
      shopping list are readable without walking up.
- [ ] Every button, tick box and row is easy to hit with a finger (64 px or
      more); nothing tiny.
- [ ] Turn the tablet: portrait and landscape both lay out without sideways
      scrolling, and nothing is cut off.
- [ ] Ticking the child's chore shows it done and the child's points go up
      (not yours); it shows on the child's own device after sync.
- [ ] Add something to Shopping with the on-screen keyboard; tick something
      off; both show on another device after sync.
- [ ] **Set a reward** on a child's card with **+**, **−** and a one-tap
      goal, type its name with the on-screen keyboard, and **Save reward**:
      opening the editor asks nothing, but saving asks for your passkey or
      password (#705). **Don't change it** closes the question and the
      reward stays as it was; a wrong password is refused calmly and nothing
      changes; your passkey or password saves it, and the card shows "N of G
      for …" and the child's own device shows it after sync. **Undo** on the
      toast asks again, then puts the old reward back; **Remove reward** asks
      too. **Change reward** and **Cancel** change nothing. The keyboard
      doesn't pop up until you tap the reward's name. Ticking chores,
      shopping and the fridge never ask.
- [ ] The fridge, in portrait and landscape: the tools sit beside the door,
      the whole door shows, and the notes under it are readable from 2–3 m.
      Draw on the fridge with a finger; tap a magnet and move it with one
      of the nine place buttons; nothing needs a long press, a hover or a
      precise tap. With the fridge set to look only, its tools are gone.
- [ ] Switch **Fridge** off under Household › Features on another device:
      the fridge panel goes from the display; back on, it returns.
- [ ] Recent messages show, with no way to write; reading them here doesn't
      mark them read on your phone.
- [ ] Try to get elsewhere: the browser back button, a link, a shared item
      or a home-screen shortcut all stay on the display. Your journal, Just
      for me, reminders, Search and Household settings never appear.

## Screen

- [ ] Leave it untouched for longer than the tablet's own screen timeout:
      the screen stays on (Screen Wake Lock). If it doesn't, note the browser
      and whether battery saver is on.
- [ ] After the quiet minutes, family photos show (or a clock with no
      photos); a tap brings the panels back and doesn't tick anything.
- [ ] Set the night to start in two minutes: the screen dims; a tap wakes
      it; it dims again after the quiet minutes; it brightens at the end of
      the night by itself.
- [ ] Switch to another app and back, or turn the screen off and on: the
      display is still there and the screen stays on again.
- [ ] Turn on reduced motion, dark mode and high contrast (system settings):
      the display follows each.

## Offline and power

- [ ] Turn Wi-Fi off: it says it is offline and keeps showing everything;
      ticking still works and syncs when Wi-Fi is back.
- [ ] Restart the tablet (or close the browser): Kin asks to unlock; after
      unlocking it opens as the display again.

## Leaving

- [ ] **Leave display mode** asks for your passkey or password; **Stay in
      display mode** keeps it.
- [ ] A wrong password is refused and the display stays.
- [ ] Your passkey (or password) leaves; Kin reloads into the full layout,
      still unlocked, and auto-lock works again.
- [ ] An admin switching **Kitchen display** off under Household › Features
      locks the display device the next time it connects.
