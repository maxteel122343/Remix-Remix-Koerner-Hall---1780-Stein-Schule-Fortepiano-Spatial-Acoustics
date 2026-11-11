/**
 * Pure Inline <svg> 2D Floor Plan Popover for Koerner Hall Fortepiano Edition (~1,135 Seats + Interactive c. 1780 Stein-Schule Fortepiano)
 * Zero HTML5 2D <canvas> usage (immune to headless Chrome 154/155 2D canvas hangs).
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export class SeatMapPopover {
  constructor({
    popoverEl,
    svgEl,
    tooltipEl,
    summaryEl,
    triggerBtn,
    closeBtn,
    onSelectSeat,
    onSelectPiano,
  }) {
    this.popoverEl = popoverEl;
    this.svgEl = svgEl;
    this.tooltipEl = tooltipEl;
    this.summaryEl = summaryEl;
    this.triggerBtn = triggerBtn;
    this.closeBtn = closeBtn;
    this.onSelectSeat = onSelectSeat;
    this.onSelectPiano = onSelectPiano || null;

    this.seats = [];
    this.currentTier = "Orchestra";
    this.activeSeat = null;
    this.isPianoActive = false;
    this.isOpen = false;
    this._dotBySeatIndex = new Map();
    this._seatByIndex = new Map();
    this._activeRingEl = null;
    this._pianoPathEl = null;
    this._benchRectEl = null;

    this._bindUI();
  }

  _bindUI() {
    const blurOnFocus = (el) => {
      if (el) el.addEventListener("focus", () => el.blur());
    };
    blurOnFocus(this.triggerBtn);
    blurOnFocus(this.closeBtn);

    const tabs = this.popoverEl.querySelectorAll(".tier-tab");
    tabs.forEach((tab) => {
      blurOnFocus(tab);
      tab.addEventListener("click", (e) => {
        e.stopPropagation();
        this.setTier(tab.dataset.tier);
      });
    });

    this.triggerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggle();
    });

    this.closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.close();
    });

    document.addEventListener("pointerdown", (e) => {
      if (!this.isOpen) return;
      if (this.popoverEl.contains(e.target) || this.triggerBtn.contains(e.target)) return;
      this.close();
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen) {
        this.close();
      }
    });
  }

  setSeats(seats) {
    this.seats = Array.isArray(seats) ? seats : [];
    this._seatByIndex.clear();
    for (const s of this.seats) {
      this._seatByIndex.set(s._index, s);
    }
    if (this.activeSeat) {
      this.currentTier = this.activeSeat.tier || "Orchestra";
    }
    this._syncTabs();
    this.renderSVG();
  }

  setActiveSeat(seat) {
    this.activeSeat = seat;
    if (seat) {
      this.isPianoActive = false;
      const label = `${seat.tier} \u00B7 Row ${seat.row} \u00B7 Seat ${seat.seat_number} ${this.isOpen ? "\u25BE" : "\u25B4"}`;
      this.triggerBtn.textContent = label;

      if (this.isOpen && seat.tier && seat.tier !== this.currentTier) {
        this.currentTier = seat.tier;
        this._syncTabs();
        this.renderSVG();
      } else {
        this._updateActiveHighlight();
      }
      return;
    }

    if (this.isPianoActive) {
      this.triggerBtn.textContent = `Stage \u00B7 1780 Fortepiano ${this.isOpen ? "\u25BE" : "\u25B4"}`;
    }
    this._updateActiveHighlight();
  }

  setPianoActive(active) {
    this.isPianoActive = Boolean(active);
    if (this.isPianoActive) {
      this.activeSeat = null;
      this.triggerBtn.textContent = `Stage \u00B7 1780 Fortepiano ${this.isOpen ? "\u25BE" : "\u25B4"}`;
    }
    this._updateActiveHighlight();
  }

  open() {
    this.isOpen = true;
    this.popoverEl.hidden = false;
    if (this.activeSeat?.tier) {
      this.currentTier = this.activeSeat.tier;
      this._syncTabs();
    }
    this.renderSVG();
    if (this.isPianoActive) {
      this.triggerBtn.textContent = "Stage \u00B7 1780 Fortepiano \u25BE";
      this._updateActiveHighlight();
    } else {
      this.setActiveSeat(this.activeSeat);
    }
  }

  close() {
    this.isOpen = false;
    this.popoverEl.hidden = true;
    this.tooltipEl.hidden = true;
    if (this.isPianoActive) {
      this.triggerBtn.textContent = "Stage \u00B7 1780 Fortepiano \u25B4";
    } else if (this.activeSeat) {
      this.triggerBtn.textContent = `${this.activeSeat.tier} \u00B7 Row ${this.activeSeat.row} \u00B7 Seat ${this.activeSeat.seat_number} \u25B4`;
    }
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  setTier(tierName) {
    this.currentTier = tierName;
    this._syncTabs();
    this.renderSVG();
  }

  _syncTabs() {
    const tabs = this.popoverEl.querySelectorAll(".tier-tab");
    tabs.forEach((t) => {
      const active = t.dataset.tier === this.currentTier;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  renderSVG() {
    while (this.svgEl.firstChild) {
      this.svgEl.removeChild(this.svgEl.firstChild);
    }
    this._dotBySeatIndex.clear();
    this._activeRingEl = null;
    this._pianoPathEl = null;
    this._benchRectEl = null;

    const tierSeats = this.seats.filter((s) => s.tier === this.currentTier);
    const totalCount = this.seats.length;
    if (this.summaryEl) {
      this.summaryEl.textContent = `${this.currentTier} (${tierSeats.length} seats) \u00B7 Click 1780 Fortepiano or any of ${totalCount.toLocaleString()} seats`;
    }

    // Compute dynamic viewBox in Blender plan coordinates (X horizontal, Y vertical downward from stage at top)
    let minX = -11.5, maxX = 11.5, minY = -14.5, maxY = 26.5;
    if (tierSeats.length > 0) {
      minX = Math.min(-10.5, ...tierSeats.map((s) => s.x)) - 1.6;
      maxX = Math.max(10.5, ...tierSeats.map((s) => s.x)) + 1.6;
      minY = Math.min(-11.8, ...tierSeats.map((s) => s.y)) - 1.8;
      maxY = Math.max(3.0, ...tierSeats.map((s) => s.y)) + 2.0;
    }
    const width = maxX - minX;
    const height = maxY - minY;
    this.svgEl.setAttribute("viewBox", `${minX.toFixed(2)} ${minY.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)}`);

    // 1. Concert Stage & Shoebox Architectural Outline (exact KPMB / RCM plan geometry)
    const stageGroup = document.createElementNS(SVG_NS, "g");

    // Outer shoebox perimeter (x = +-10.8, y = -14.2 .. +24.0)
    const hallOutline = document.createElementNS(SVG_NS, "rect");
    hallOutline.setAttribute("x", "-10.8");
    hallOutline.setAttribute("y", "-14.0");
    hallOutline.setAttribute("width", "21.6");
    hallOutline.setAttribute("height", "37.4");
    hallOutline.setAttribute("rx", "0.6");
    hallOutline.setAttribute("fill", "rgba(255, 255, 255, 0.015)");
    hallOutline.setAttribute("stroke", "rgba(250, 249, 246, 0.10)");
    hallOutline.setAttribute("stroke-width", "0.09");
    stageGroup.appendChild(hallOutline);

    // Concert Stage deck (x = -8.0..+8.0, front apron y = -0.0085*x^2, rear arc y = -11.2)
    const stageRect = document.createElementNS(SVG_NS, "path");
    stageRect.setAttribute(
      "d",
      "M -8.0 -11.0 Q 0 -11.5 8.0 -11.0 L 8.0 -0.54 Q 0 0.50 -8.0 -0.54 Z"
    );
    stageRect.setAttribute("fill", "rgba(214, 186, 118, 0.13)");
    stageRect.setAttribute("stroke", "rgba(214, 186, 118, 0.45)");
    stageRect.setAttribute("stroke-width", "0.11");
    stageGroup.appendChild(stageRect);

    // Sound Mix booth notch at rear Orchestra (x = -1.42..+1.42, y = 20.0..22.85)
    if (this.currentTier === "Orchestra") {
      const mixBox = document.createElementNS(SVG_NS, "rect");
      mixBox.setAttribute("x", "-1.42");
      mixBox.setAttribute("y", "20.0");
      mixBox.setAttribute("width", "2.84");
      mixBox.setAttribute("height", "2.65");
      mixBox.setAttribute("rx", "0.18");
      mixBox.setAttribute("fill", "rgba(250, 249, 246, 0.04)");
      mixBox.setAttribute("stroke", "rgba(250, 249, 246, 0.18)");
      mixBox.setAttribute("stroke-width", "0.08");
      stageGroup.appendChild(mixBox);
    }

    // Balcony horseshoe fascia reference curve when viewing Lower/Upper Balcony
    if (this.currentTier === "Lower Balcony" || this.currentTier === "Upper Balcony") {
      const frontY = this.currentTier === "Lower Balcony" ? 16.9 : 19.08;
      const sideX = this.currentTier === "Lower Balcony" ? 8.12 : 9.14;
      const balcArc = document.createElementNS(SVG_NS, "path");
      balcArc.setAttribute(
        "d",
        `M -${sideX} 3.2 L -${sideX} ${(frontY - 1.1).toFixed(2)} Q 0 ${(frontY + 1.0).toFixed(2)} ${sideX} ${(frontY - 1.1).toFixed(2)} L ${sideX} 3.2`
      );
      balcArc.setAttribute("fill", "none");
      balcArc.setAttribute("stroke", "rgba(212, 163, 106, 0.35)");
      balcArc.setAttribute("stroke-width", "0.10");
      balcArc.setAttribute("stroke-dasharray", "0.35 0.25");
      stageGroup.appendChild(balcArc);
    }

    // Interactive Clickable c. 1780 Stein-Schule South German Fortepiano silhouette on stage
    // Plan-view X is negated relative to Three.js world X (+X = House Left / Screen Left when facing stage)
    // so the bench & keyboard sit Stage Right (map left) with the bass spine upstage and bentside opening to Orchestra.
    const pianoPath = document.createElementNS(SVG_NS, "path");
    pianoPath.setAttribute(
      "d",
      "M -0.84 -3.17 L -0.84 -4.13 L 1.26 -4.13 L 1.08 -3.90 Q 0.45 -3.72 -0.27 -3.17 Z"
    );
    pianoPath.setAttribute("class", "stage-piano-hit");
    stageGroup.appendChild(pianoPath);
    this._pianoPathEl = pianoPath;

    const benchRect = document.createElementNS(SVG_NS, "rect");
    benchRect.setAttribute("x", "-1.39");
    benchRect.setAttribute("y", "-4.01");
    benchRect.setAttribute("width", "0.34");
    benchRect.setAttribute("height", "0.72");
    benchRect.setAttribute("rx", "0.05");
    benchRect.setAttribute("class", "stage-piano-hit");
    stageGroup.appendChild(benchRect);
    this._benchRectEl = benchRect;

    const bindPianoHit = (el) => {
      el.addEventListener("pointerenter", (ev) => {
        this._showCustomTooltip("Concert Stage \u00B7 c. 1780 Stein-Schule Fortepiano (Click to Navigate)", ev);
      });
      el.addEventListener("pointermove", (ev) => {
        this._showCustomTooltip("Concert Stage \u00B7 c. 1780 Stein-Schule Fortepiano (Click to Navigate)", ev);
      });
      el.addEventListener("pointerleave", () => {
        this.tooltipEl.hidden = true;
      });
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (this.onSelectPiano) this.onSelectPiano();
      });
    };
    bindPianoHit(pianoPath);
    bindPianoHit(benchRect);

    const stageLabel = document.createElementNS(SVG_NS, "text");
    stageLabel.setAttribute("x", "0");
    stageLabel.setAttribute("y", "-6.8");
    stageLabel.setAttribute("text-anchor", "middle");
    stageLabel.setAttribute("fill", "rgba(214, 186, 118, 0.78)");
    stageLabel.setAttribute("font-size", "0.92");
    stageLabel.setAttribute("font-weight", "500");
    stageLabel.setAttribute("letter-spacing", "0.14");
    stageLabel.setAttribute("pointer-events", "none");
    stageLabel.textContent = "CONCERT STAGE";
    stageGroup.appendChild(stageLabel);
    this.svgEl.appendChild(stageGroup);

    // 2. Context ghost dots for other tiers so horseshoe relationship is clear
    const ghostGroup = document.createElementNS(SVG_NS, "g");
    for (const s of this.seats) {
      if (s.tier === this.currentTier) continue;
      const gDot = document.createElementNS(SVG_NS, "circle");
      gDot.setAttribute("cx", s.x.toFixed(2));
      gDot.setAttribute("cy", s.y.toFixed(2));
      gDot.setAttribute("r", "0.13");
      gDot.setAttribute("fill", "rgba(250, 249, 246, 0.08)");
      ghostGroup.appendChild(gDot);
    }
    this.svgEl.appendChild(ghostGroup);

    // 3. Interactive clickable seat dots for active tier
    const dotsGroup = document.createElementNS(SVG_NS, "g");
    const dotRadius = tierSeats.length > 450 ? "0.21" : "0.24";

    for (const seat of tierSeats) {
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", seat.x.toFixed(3));
      circle.setAttribute("cy", seat.y.toFixed(3));
      circle.setAttribute("r", dotRadius);
      circle.setAttribute("class", "seat-dot");
      circle.setAttribute(
        "fill",
        seat.is_accessible ? "#7EB693" : "rgba(218, 174, 120, 0.78)"
      );

      circle.addEventListener("pointerenter", (ev) => {
        this._showTooltip(seat, ev);
      });
      circle.addEventListener("pointermove", (ev) => {
        this._showTooltip(seat, ev);
      });
      circle.addEventListener("pointerleave", () => {
        this.tooltipEl.hidden = true;
      });
      circle.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (this.onSelectSeat) this.onSelectSeat(seat);
      });

      dotsGroup.appendChild(circle);
      this._dotBySeatIndex.set(seat._index, circle);
    }
    this.svgEl.appendChild(dotsGroup);

    // 4. Active seat ring
    const ring = document.createElementNS(SVG_NS, "circle");
    ring.setAttribute("r", "0.46");
    ring.setAttribute("fill", "none");
    ring.setAttribute("stroke", "#FAF9F6");
    ring.setAttribute("stroke-width", "0.14");
    ring.setAttribute("pointer-events", "none");
    ring.style.display = "none";
    this.svgEl.appendChild(ring);
    this._activeRingEl = ring;

    this._updateActiveHighlight();
  }

  _updateActiveHighlight() {
    for (const [idx, el] of this._dotBySeatIndex.entries()) {
      const isAct = !this.isPianoActive && this.activeSeat && this.activeSeat._index === idx;
      const seatObj = this._seatByIndex.get(idx);
      const baseFill = seatObj?.is_accessible ? "#7EB693" : "rgba(218, 174, 120, 0.78)";
      el.setAttribute("fill", isAct ? "#FAF9F6" : baseFill);
    }
    if (this._pianoPathEl) {
      this._pianoPathEl.setAttribute(
        "fill",
        this.isPianoActive ? "#FFDCA8" : "rgba(250, 249, 246, 0.65)"
      );
      this._pianoPathEl.setAttribute(
        "stroke",
        this.isPianoActive ? "#FAF9F6" : "rgba(212, 163, 106, 0.55)"
      );
      this._pianoPathEl.setAttribute("stroke-width", this.isPianoActive ? "0.12" : "0.06");
    }
    if (this._benchRectEl) {
      this._benchRectEl.setAttribute(
        "fill",
        this.isPianoActive ? "#FAF9F6" : "rgba(250, 249, 246, 0.45)"
      );
    }
    if (!this._activeRingEl) return;
    if (!this.isPianoActive && this.activeSeat && this.activeSeat.tier === this.currentTier) {
      this._activeRingEl.setAttribute("cx", this.activeSeat.x.toFixed(3));
      this._activeRingEl.setAttribute("cy", this.activeSeat.y.toFixed(3));
      this._activeRingEl.style.display = "block";
    } else {
      this._activeRingEl.style.display = "none";
    }
  }

  _showCustomTooltip(text, ev) {
    const wrapRect = this.svgEl.parentElement.getBoundingClientRect();
    const x = ev.clientX - wrapRect.left;
    const y = ev.clientY - wrapRect.top;
    this.tooltipEl.textContent = text;
    this.tooltipEl.style.left = `${x}px`;
    this.tooltipEl.style.top = `${y}px`;
    this.tooltipEl.hidden = false;
  }

  _showTooltip(seat, ev) {
    const accTag = seat.is_accessible ? " \u00B7 Accessible" : "";
    this._showCustomTooltip(
      `${seat.section || seat.tier} \u00B7 Row ${seat.row} \u00B7 Seat ${seat.seat_number}${accTag}`,
      ev
    );
  }
}
