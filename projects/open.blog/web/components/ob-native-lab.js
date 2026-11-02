// <ob-native-lab> shows three browser-native features at work on a small example: View
// Transitions and the Web Animations API (state and motion), the popover attribute, and the
// Intersection and Resize observers. Support labels reflect this browser, and a feature the
// browser lacks says so instead of being imitated. Children of the element are the
// no-JavaScript fallback. Nothing is stored or sent.
import {
  detectSupport, motionSupportLabel, observerSupportLabel, popoverSupportLabel,
  motionReady, popoverReady, popoverToggled, layoutPlan,
  intersectionLabel, sizeLabel, PULSE_KEYFRAMES,
} from "./ob-native-model.js";
import { ObLab, defineLab, el, field, reducedMotion, uid } from "./ob-lab.js";

class ObNativeLab extends ObLab {
  setup() {
    this.expanded = false;
    this.busy = false;
    this.card = el("div", { class: "ob-native-card" });
    this.cardLabel = el("span", {}, "Compact layout");
    const body = el("div", {});
    body.append(el("strong", {}, "Browser-native"), this.cardLabel);
    this.card.append(el("span", { class: "ob-native-icon", "aria-hidden": "true" }), body);
    this.layout = el("div", { class: "ob-native-layout", "data-layout": "compact" });
    this.layout.append(this.card);

    const card = this.card;
    this.support = detectSupport({
      document, probe: card, IntersectionObserver: globalThis.IntersectionObserver,
      ResizeObserver: globalThis.ResizeObserver,
    });
    // Popover support is a property of any element, so probe one built for it.
    const popover = el("div", { popover: "auto", id: uid("ob-native-popover"), class: "ob-native-popover" });
    this.support.popover = detectSupport({ document, probe: popover }).popover;

    this.toggle = el("button", { type: "button" }, "Expand card");
    this.pulse = el("button", { type: "button" }, this.support.animations ? "Pulse once" : "Web Animations unavailable");
    this.pulse.disabled = !this.support.animations;
    this.motionStatus = el("p", { class: "ob-native-status", role: "status" }, motionReady(this.support));
    this.toggle.addEventListener("click", () => this.changeLayout());
    this.pulse.addEventListener("click", () => this.pulseCard());
    const controls = el("div", { class: "ob-native-controls" });
    controls.append(this.toggle, this.pulse);

    this.append(
      el("p", { class: "ob-native-note" }, "Real browser APIs on small examples. Support labels reflect this browser; unsupported features explain their limits instead of pretending to run."),
      this.section("01 / State and motion", motionSupportLabel(this.support), [
        el("p", {}, "Switch the layout with a View Transition, or pulse the card with the Web Animations API. Reduced motion keeps changes instant."),
        this.layout, controls, this.motionStatus,
        el("code", { class: "ob-native-api" }, "document.startViewTransition(update)"),
      ]),
      this.section("02 / Popover", popoverSupportLabel(this.support), this.popoverParts(popover)),
      this.section("03 / Observers", observerSupportLabel(this.support), this.observerParts()));

    this.motion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    this.onMotionChange = () => {
      if (!this.motion.matches) return;
      this.transition?.skipTransition();
      this.animation?.cancel();
      this.motionStatus.textContent = "Motion stopped, following your reduced-motion preference.";
    };
    this.motion?.addEventListener?.("change", this.onMotionChange);
  }

  section(title, support, children) {
    const box = el("section", { class: "ob-native-section" });
    const bar = el("h3", {});
    bar.append(title, " ", el("small", {}, support));
    box.append(bar, ...children);
    return box;
  }

  popoverParts(popover) {
    popover.append(el("p", {}, "This panel is in the browser's top layer. Press Escape or click outside to dismiss it."));
    this.popoverStatus = el("p", { class: "ob-native-status", role: "status" }, popoverReady(this.support));
    const open = el("button", { type: "button", popovertarget: popover.id }, "Open popover");
    open.hidden = !this.support.popover;
    if (this.support.popover) {
      popover.addEventListener("toggle", (event) => {
        this.popoverStatus.textContent = popoverToggled(event.newState);
      });
    }
    this.popoverPanel = popover;
    return [el("p", {}, "The popover attribute gives you light-dismiss, Escape and top-layer stacking with no script."), open, popover, this.popoverStatus];
  }

  observerParts() {
    this.target = el("div", { class: "ob-native-target" }, "Observed target");
    this.root = el("div", { class: "ob-native-root", tabindex: "0", "aria-label": "Scrollable demo viewport" });
    this.root.append(el("div", { class: "ob-native-spacer" }), this.target, el("div", { class: "ob-native-spacer" }));
    const width = el("input", { type: "range", min: "30", max: "100", value: "70" });
    const widthField = field("Target width", width, "ob-native-field");
    const widthOut = el("output", { for: width.id }, "70%");
    widthField.append(widthOut);
    this.intersectionOut = el("p", { class: "ob-native-readout" }, this.support.intersection ? "Scroll the viewport" : "IntersectionObserver unavailable");
    this.sizeOut = el("p", { class: "ob-native-readout" }, this.support.resize ? "Measuring…" : "ResizeObserver unavailable");
    this.target.style.width = "70%";
    width.addEventListener("input", () => {
      this.target.style.width = `${width.value}%`;
      widthOut.textContent = `${width.value}%`;
    });
    if (this.support.intersection) {
      const root = this.root;
      this.intersection = new IntersectionObserver(([entry]) => {
        this.intersectionOut.textContent = intersectionLabel(entry.intersectionRatio);
        this.target.classList.toggle("ob-native-in-view", entry.isIntersecting);
      }, { root, threshold: [0, 0.25, 0.5, 0.75, 1] });
    }
    if (this.support.resize) {
      this.resize = new ResizeObserver(([entry]) => {
        this.sizeOut.textContent = sizeLabel(entry.contentRect.width, entry.contentRect.height);
      });
    }
    return [el("p", {}, "Scroll the viewport and resize the target: both observers report without polling."), this.root, widthField, this.intersectionOut, this.sizeOut];
  }

  watch() {
    this.intersection?.observe(this.target);
    this.resize?.observe(this.target);
  }

  connectedCallback() {
    super.connectedCallback();
    // Also runs when a moved element returns, after disconnectedCallback stopped its observers.
    this.watch();
  }

  disconnectedCallback() {
    this.intersection?.disconnect();
    this.resize?.disconnect();
    this.transition?.skipTransition();
    this.animation?.cancel();
    this.motion?.removeEventListener?.("change", this.onMotionChange);
    if (this.support?.popover && this.popoverPanel?.matches(":popover-open")) this.popoverPanel.hidePopover();
  }

  applyLayout() {
    this.expanded = !this.expanded;
    this.layout.dataset.layout = this.expanded ? "expanded" : "compact";
    this.cardLabel.textContent = this.expanded ? "Expanded layout" : "Compact layout";
    this.toggle.textContent = this.expanded ? "Compact card" : "Expand card";
  }

  async changeLayout() {
    if (this.busy) return;
    const plan = layoutPlan(this.support, reducedMotion());
    if (!plan.transition) {
      this.applyLayout();
      this.motionStatus.textContent = plan.status;
      return;
    }
    this.busy = true;
    this.toggle.disabled = true;
    try {
      this.transition = document.startViewTransition(() => this.applyLayout());
      // A skipped visual transition can reject `ready` while the DOM update still succeeds.
      this.transition.ready.catch((error) => {
        if (error.name !== "AbortError") this.report("Transition visuals", error);
      });
      await this.transition.finished;
      this.motionStatus.textContent = plan.status;
    } catch (error) {
      this.report("View Transition", error);
    } finally {
      this.transition = undefined;
      this.busy = false;
      this.toggle.disabled = false;
    }
  }

  async pulseCard() {
    if (!this.support.animations) return;
    if (reducedMotion()) {
      this.motionStatus.textContent = "Pulse skipped, following your reduced-motion preference.";
      return;
    }
    this.animation?.cancel();
    let current;
    try {
      current = this.card.animate(PULSE_KEYFRAMES, { duration: 500, easing: "ease-in-out" });
      this.animation = current;
      await current.finished;
      this.motionStatus.textContent = "One pulse completed with the Web Animations API.";
    } catch (error) {
      if (error.name !== "AbortError") this.report("Web Animation", error);
    } finally {
      if (this.animation === current) this.animation = undefined;
    }
  }

  report(name, error) {
    console.error(`Native API lab ${name}:`, error);
    this.motionStatus.textContent = `${name} failed: ${error.message}. You can try again.`;
  }
}

defineLab("ob-native-lab", ObNativeLab);
