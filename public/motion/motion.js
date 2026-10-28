// =============================================================================
// PrimeBridge Motion Kit — motion.js
// Generic helpers that follow the four motion rules (see motion.css header).
// Plain JavaScript, no libraries. Uses the browser's Web Animations API.
//
//   <script src="/motion/motion.js"></script>
//   Motion.show(el, { axis: "y" });          // fade + move up into place
//   Motion.hide(el, { axis: "x" });          // fade + move out sideways
//   Motion.changeState(el, { scale: 1.04 }); // scaling for a state change
//   await Motion.sequence([...]);            // one clear order, few at once
//   Motion.revealOnScroll(".card");          // appear once, bottom to top
// =============================================================================

const Motion = (() => {
  const prefersReduced = () =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const EASE = {
    in: "cubic-bezier(0.16, 1, 0.3, 1)",     // arriving
    out: "cubic-bezier(0.4, 0, 1, 1)",       // leaving
    state: "cubic-bezier(0.4, 0, 0.2, 1)",   // changing in place
  };

  // ---------------------------------------------------------------------------
  // RULE 4 — TIMING: duration depends on element size and distance travelled.
  // Small/near = fast, big/far = slower, always kept between 120ms and 600ms.
  // ---------------------------------------------------------------------------
  function durationFor(el, distance = 0) {
    const rect = el.getBoundingClientRect();
    const size = Math.sqrt(rect.width * rect.height); // "how big it feels"
    const ms = 120 + size * 0.6 + Math.abs(distance) * 1.5;
    return Math.round(Math.min(600, Math.max(120, ms)));
  }

  // ---------------------------------------------------------------------------
  // RULE 1 — DIRECTION: only one axis. A move is "x" (horizontal) or "y"
  // (vertical). Anything else is rejected, so nothing ever moves at an angle.
  // ---------------------------------------------------------------------------
  function translate(axis, px) {
    if (axis !== "x" && axis !== "y") {
      throw new Error(`Motion: axis must be "x" or "y" (got "${axis}") — no diagonal movement.`);
    }
    return axis === "x" ? `translateX(${px}px)` : `translateY(${px}px)`;
  }

  // Runs an animation and returns a Promise that also carries .duration (ms),
  // so sequence() knows how long each step takes.
  function run(el, keyframes, { duration, easing, delay = 0 }) {
    if (prefersReduced()) {
      // keep the end state, skip the movement
      const last = keyframes[keyframes.length - 1];
      if (last.opacity !== undefined) el.style.opacity = last.opacity;
      return Object.assign(Promise.resolve(), { duration: 0 });
    }
    const anim = el.animate(keyframes, { duration, easing, delay, fill: "forwards" });
    const done = anim.finished.then(() => {
      // hand the final look back to normal CSS, then drop the animation
      const last = keyframes[keyframes.length - 1];
      if (last.opacity !== undefined) el.style.opacity = last.opacity;
      el.style.transform = last.transform && last.transform !== "none" ? last.transform : "";
      anim.cancel();
    }).catch(() => {}); // a cancelled animation is not an error
    return Object.assign(done, { duration: duration + delay });
  }

  // ---------------------------------------------------------------------------
  // RULE 3 — OPACITY (+ optional straight move): showing and hiding.
  // ---------------------------------------------------------------------------
  function show(el, { axis = "y", distance = 16, scale = 1, delay = 0, duration } = {}) {
    el.hidden = false;
    el.style.pointerEvents = "";
    const from = [distance ? translate(axis, distance) : "", scale !== 1 ? `scale(${scale})` : ""].join(" ").trim();
    return run(
      el,
      [
        { opacity: 0, transform: from || "none" },
        { opacity: 1, transform: "none" },
      ],
      { duration: duration ?? durationFor(el, distance), easing: EASE.in, delay }
    );
  }

  function hide(el, { axis = "y", distance = 8, delay = 0, duration, remove = false } = {}) {
    el.style.pointerEvents = "none";
    const p = run(
      el,
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: distance ? translate(axis, distance) : "none" },
      ],
      // leaving is a little quicker than arriving
      { duration: duration ?? Math.round(durationFor(el, distance) * 0.75), easing: EASE.out, delay }
    );
    const finished = p.then(() => {
      if (remove) el.remove();
      else { el.hidden = true; el.style.opacity = ""; el.style.transform = ""; }
    });
    return Object.assign(finished, { duration: p.duration });
  }

  // ---------------------------------------------------------------------------
  // RULE 2 — SCALING: show a change of state (e.g. selected, expanded, pressed).
  // Can be combined with a straight move via axis/distance.
  // ---------------------------------------------------------------------------
  function changeState(el, { scale = 1.04, axis, distance = 0, duration } = {}) {
    const end = [axis && distance ? translate(axis, distance) : "", `scale(${scale})`].join(" ").trim();
    return run(
      el,
      [{ transform: "none" }, { transform: end }],
      { duration: duration ?? durationFor(el, distance), easing: EASE.state }
    );
  }

  // Expand an element from its current size to a new one (e.g. a card opening).
  // Uses the "FLIP" technique: measure, change, then animate the difference with scale.
  function transformTo(el, applyChange) {
    const first = el.getBoundingClientRect();
    applyChange();                                   // e.g. el.classList.add("is-open")
    const last = el.getBoundingClientRect();
    const sx = first.width / last.width;
    const sy = first.height / last.height;
    el.style.transformOrigin = "top left";
    return run(
      el,
      [
        { transform: `scale(${sx}, ${sy})` },
        { transform: "none" },
      ],
      { duration: durationFor(el, Math.abs(last.height - first.height)), easing: EASE.state }
    );
  }

  // ---------------------------------------------------------------------------
  // RULE 4 — SEQUENCE: one clear order, as few elements moving at once as possible.
  // steps = array of functions that each return a Promise (e.g. () => Motion.show(a)).
  // overlap 0 = strictly one after another; 0.3 = next starts when previous is 70% done.
  // ---------------------------------------------------------------------------
  async function sequence(steps, { overlap = 0.3 } = {}) {
    let last = Promise.resolve();
    for (const step of steps) {
      const p = step();
      last = p;
      const ms = p && p.duration ? p.duration : 0;
      if (overlap <= 0 || !ms) await p;
      else await wait(ms * (1 - overlap)); // let the next one start near the end of this one
    }
    await last; // resolve when the final step has finished
  }

  // Simple stagger for a list: same animation, clear order, small gap.
  function stagger(elements, fn, gap = 70) {
    return Promise.all([...elements].map((el, i) => fn(el, { delay: i * gap })));
  }

  // ---------------------------------------------------------------------------
  // Reveal on scroll: elements appear once, bottom to top, when they enter view.
  // ---------------------------------------------------------------------------
  function revealOnScroll(selector, { axis = "y", distance = 16 } = {}) {
    const items = document.querySelectorAll(selector);
    items.forEach((el) => (el.style.opacity = "0"));
    const io = new IntersectionObserver(
      (entries) => {
        entries
          .filter((e) => e.isIntersecting)
          .forEach((e, i) => {
            e.target.style.opacity = "";
            show(e.target, { axis, distance, delay: i * 70 });
            io.unobserve(e.target); // only animate once
          });
      },
      { threshold: 0.15 }
    );
    items.forEach((el) => io.observe(el));
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  return { show, hide, changeState, transformTo, sequence, stagger, revealOnScroll, durationFor, wait };
})();
