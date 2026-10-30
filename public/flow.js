// =============================================================================
// EnergyFlow — one live energy-flow diagram (shared by the dashboard and the
// side-by-side page). Every part is found through data-k="…" inside its own
// <svg>, so several diagrams can live on one page.
//
//   const flow = EnergyFlow.create(svgElement);
//   flow.render(snapshotFromApiLive);
//
// Motion follows the PrimeBridge Motion Kit rules:
//   wires are only horizontal or vertical · state change = scale · speed = power
// =============================================================================
(function () {
  const IDLE = 20; // W – below this a flow counts as idle

  function watts(w) {
    if (w === null || w === undefined) return "–";
    const abs = Math.abs(w);
    return abs >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${Math.round(w)} W`;
  }
  const fixed = (v, dp, unit) => (v === null || v === undefined ? "–" : `${Number(v).toFixed(dp)} ${unit}`);

  async function pulse(el) {
    if (!window.Motion) return;
    await Motion.changeState(el, { scale: 1.035, duration: 160 });
    await Motion.changeState(el, { scale: 1, duration: 200 });
  }

  // Two layouts, both with only horizontal and vertical wires:
  //   wide    – grid | inverter | consumption in a row, solar above, battery below
  //   compact – a 2 × 2 grid around the inverter, for narrow spaces (phones, half-width columns)
  const LAYOUTS = {
    wide: {
      viewBox: "0 0 800 470",
      nodes: { solar: [315, 8], grid: [16, 183], inverter: [325, 191], home: [614, 183], battery: [315, 358] },
      wires: { solar: "M400 112 V191", grid: "M186 235 H325", home: "M475 235 H614", battery: "M400 279 V358" },
    },
    compact: {
      viewBox: "0 0 380 392",
      nodes: { solar: [0, 0], grid: [210, 0], inverter: [115, 150], home: [210, 286], battery: [0, 286] },
      wires: { solar: "M85 104 V176 H115", grid: "M295 104 V176 H265", home: "M265 214 H295 V286", battery: "M115 214 H85 V286" },
    },
  };
  const COMPACT_BELOW = 520; // px width of the diagram itself, not the window

  function create(svg) {
    const k = (key) => svg.querySelector(`[data-k="${key}"]`);
    const lastPower = {};
    let current = null;

    // --- layout follows the space the diagram actually has
    function applyLayout() {
      const width = svg.parentElement.getBoundingClientRect().width;
      const name = width && width < COMPACT_BELOW ? "compact" : "wide";
      if (name === current) return;
      current = name;
      const L = LAYOUTS[name];
      svg.setAttribute("viewBox", L.viewBox);
      Object.entries(L.nodes).forEach(([id, [x, y]]) => k(`pos-${id}`).setAttribute("transform", `translate(${x},${y})`));
      Object.entries(L.wires).forEach(([id, d]) => {
        k(`wire-${id}`).setAttribute("d", d);
        k(`flow-${id}`).setAttribute("d", d);
      });
    }
    applyLayout();
    new ResizeObserver(applyLayout).observe(svg.parentElement);

    // Speed follows power: idle lines fade out, busy lines move faster
    function setFlow(id, power, forward) {
      const line = k(`flow-${id}`);
      const active = power !== null && Math.abs(power) > IDLE;
      line.classList.toggle("is-active", active);
      line.classList.toggle("is-reverse", active && !forward);
      if (active) {
        const pxPerSec = Math.min(160, 24 + Math.abs(power) / 30); // 0.1 kW ≈ 27px/s … 4 kW ≈ 157px/s
        line.style.setProperty("--flow-dur", `${(20 / pxPerSec).toFixed(2)}s`);
      }
      return active;
    }

    // A node gives a short scale pulse when its value changes noticeably (state change = scaling)
    function setNode(id, valueText, subText, power, active) {
      const node = k(`node-${id}`);
      const valueEl = k(`${id}-value`);
      const changed = valueEl.textContent !== valueText;
      valueEl.textContent = valueText;
      k(`${id}-sub`).textContent = subText;
      node.classList.toggle("is-active", Boolean(active));

      const prev = lastPower[id];
      lastPower[id] = power;
      if (changed && prev !== undefined && power !== null && prev !== null) {
        const delta = Math.abs(power - prev);
        if (delta > 100 && delta > Math.abs(prev) * 0.1) pulse(node);
      }
    }

    function render(d) {
      const solar = d.solar.total ?? 0;
      const grid = d.grid.total ?? 0;
      const load = d.load.total ?? 0;
      const bp = d.battery.power ?? 0;

      const solarOn = setFlow("solar", solar, true);
      const gridOn = setFlow("grid", grid, grid > 0);   // import: grid → inverter
      const homeOn = setFlow("home", load, true);
      const battOn = setFlow("battery", bp, bp > 0);     // charging: inverter → battery

      setNode("solar", watts(solar), `Today ${fixed(d.solar.yieldTodayKwh, 1, "kWh")}`, solar, solarOn);
      setNode("grid", watts(Math.abs(grid)), grid > IDLE ? "Importing" : grid < -IDLE ? "Exporting" : "Balanced", grid, gridOn);
      setNode("home", watts(load), `Essential ${watts(d.load.essential)}`, load, homeOn);
      setNode("inverter", d.inverter.state ?? "–", d.inverter.systemState ?? "", null, true);

      const soc = d.battery.soc;
      setNode(
        "battery",
        soc === null ? "–" : `${Math.round(soc)}%`,
        bp > IDLE ? `Charging ${watts(bp)}` : bp < -IDLE ? `Discharging ${watts(-bp)}` : "Idle",
        bp,
        battOn
      );
      // SOC bar: the fill scales to the new level; the marker shows the ESS reserve
      k("soc-fill").style.transform = `scaleX(${Math.max(0, Math.min(100, soc ?? 0)) / 100})`;
      const limit = k("soc-limit");
      if (d.battery.socLimit !== null) {
        limit.setAttribute("x", 16 + (138 * d.battery.socLimit) / 100 - 1);
        limit.classList.add("is-set");
      }

      // Screen-reader summary of the picture
      k("summary").textContent =
        `Solar ${watts(solar)}. Grid ${grid > IDLE ? "importing" : grid < -IDLE ? "exporting" : "balanced"} ${watts(Math.abs(grid))}. ` +
        `Consumption ${watts(load)}. Battery ${soc === null ? "unknown" : Math.round(soc) + "%"}, ` +
        `${bp > IDLE ? "charging" : bp < -IDLE ? "discharging" : "idle"} ${watts(Math.abs(bp))}.`;
    }

    return { render, applyLayout };
  }

  window.EnergyFlow = { create, watts, fixed, pulse, IDLE };
})();
