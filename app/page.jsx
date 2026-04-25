"use client";

import { useState, useEffect, useCallback } from "react";

// ─── DESIGN TOKENS ───────────────────────────────────────────────────────────
const T = {
  bg: "#0D0F14",
  bgCard: "#13161E",
  bgInput: "#1A1E28",
  border: "#2A2F3E",
  borderHi: "#3D4559",
  accent: "#00E5A0",
  accentDim: "#00A374",
  accentGlow: "rgba(0,229,160,0.12)",
  text: "#E8EAEF",
  textMuted: "#7A8399",
  textDim: "#4A5168",
  danger: "#FF5C5C",
  warn: "#F5A623",
  info: "#5B9CF6",
  purple: "#9B7DFF",
  fontMono: "'JetBrains Mono', 'Fira Code', monospace",
  fontSans: "'DM Sans', system-ui, sans-serif",
};

// ─── PRINTER PROFILES (opaque — no formula exposure) ─────────────────────────
const PRINTER_DB = {
  neptune4: {
    id: "neptune4",
    name: "Neptune 4",
    brand: "Elegoo",
    wattage: 350,
    multicolor: false,
    buildVol: "235×235×265mm",
    _p: { base: 0.12, eff: 0.88, labor: 1.05, mult: 1.0 },
  },
  bambuA1: {
    id: "bambuA1",
    name: "Bambu Lab A1 Combo",
    brand: "Bambu Lab",
    wattage: 1000,
    multicolor: true,
    buildVol: "256×256×256mm",
    _p: { base: 0.28, eff: 1.18, labor: 1.12, mult: 1.35 },
  },
};

// ─── DEFAULT FILAMENT INVENTORY ───────────────────────────────────────────────
const DEFAULT_FILAMENTS = [
  { id: "f1", brand: "Bambu Lab", type: "PLA", color: "Jade White", finish: "matte", price_per_kg: 22, active: true },
  { id: "f2", brand: "Bambu Lab", type: "PLA+", color: "Onyx Black", finish: "matte", price_per_kg: 25, active: true },
  { id: "f3", brand: "eSun", type: "Silk", color: "Gold", finish: "silk", price_per_kg: 28, active: true },
  { id: "f4", brand: "Polymaker", type: "PETG", color: "Clear", finish: "glossy", price_per_kg: 30, active: true },
  { id: "f5", brand: "Bambu Lab", type: "PLA", color: "Bambu Green", finish: "glossy", price_per_kg: 22, active: true },
  { id: "f6", brand: "Sunlu", type: "PLA+", color: "Marble White", finish: "metallic", price_per_kg: 20, active: true },
];

// ─── EDITABLE PRICING CONFIG (admin/internal only) ───────────────────────────
const DEFAULT_PRICING_CONFIG = {
  electricity_rate: 12,
  minimum_price: 100,
  markup_multiplier: 1.0,
  formula: "default_charged_total * markup_multiplier",
};

function _evaluatePricingFormula(formula, variables) {
  const safeFormula = String(formula || "").trim();
  if (!safeFormula) return null;
  if (!/^[0-9a-zA-Z_+\-*/()., %]+$/.test(safeFormula)) {
    throw new Error("Formula contains unsupported characters.");
  }
  const keys = Object.keys(variables);
  const values = keys.map((key) => variables[key]);
  const fn = new Function(...keys, `"use strict"; return (${safeFormula});`);
  const result = fn(...values);
  if (!Number.isFinite(result)) throw new Error("Formula did not return a valid number.");
  return result;
}

// ─── INTERNAL PRICING ENGINE (never exposed in UI) ────────────────────────────
function _computeEngine(job) {
  const { printers, filament, grams, hours, elecRate = 0.12, pricingConfig = DEFAULT_PRICING_CONFIG } = job;
  if (!filament || !grams || !hours || !printers?.length) return null;

  const filamentReal = (grams / 1000) * filament.price_per_kg;
  const filamentCharged = (() => {
    const base = filamentReal;
    const typeMulti = { PLA: 1.6, "PLA+": 1.75, Silk: 2.1, PETG: 1.85 }[filament.type] ?? 1.7;
    const finishMulti = { matte: 1.0, glossy: 1.05, silk: 1.15, metallic: 1.1 }[filament.finish] ?? 1.0;
    return base * typeMulti * finishMulti;
  })();

  let elecReal = 0, elecCharged = 0, printerReal = 0, printerCharged = 0;
  const perPrinterBreakdown = [];

  for (const alloc of printers) {
    const p = PRINTER_DB[alloc.id];
    if (!p) continue;
    const pct = alloc.pct / 100;
    const pHours = hours * pct;
    const pGrams = grams * pct;

    const er = (p.wattage / 1000) * pHours * elecRate;
    const ec = er * p._p.eff * (p.multicolor ? 1.08 : 1.0);
    const pr = pHours * p._p.base;
    const pc = pr * p._p.mult * p._p.labor;

    elecReal += er;
    elecCharged += ec;
    printerReal += pr;
    printerCharged += pc;

    perPrinterBreakdown.push({
      id: p.id,
      name: p.name,
      pct: alloc.pct,
      hours: +pHours.toFixed(2),
      grams: +pGrams.toFixed(1),
      elec: { real: +er.toFixed(2), charged: +ec.toFixed(2) },
      printer: { real: +pr.toFixed(2), charged: +pc.toFixed(2) },
    });
  }

  const totalReal = filamentReal + elecReal + printerReal;
  const defaultChargedTotal = filamentCharged + elecCharged + printerCharged;
  let formulaError = "";
  let computedChargedTotal = defaultChargedTotal;

  try {
    const formulaPrice = _evaluatePricingFormula(pricingConfig.formula, {
      grams,
      hours,
      filament_real: filamentReal,
      filament_charged: filamentCharged,
      electricity_real: elecReal,
      electricity_charged: elecCharged,
      printer_real: printerReal,
      printer_charged: printerCharged,
      real_total: totalReal,
      default_charged_total: defaultChargedTotal,
      markup_multiplier: Number(pricingConfig.markup_multiplier || 1),
      minimum_price: Number(pricingConfig.minimum_price || 0),
    });
    if (formulaPrice !== null) computedChargedTotal = formulaPrice;
  } catch (err) {
    formulaError = err.message || "Formula error. Using default engine price.";
  }

  const totalCharged = Math.max(computedChargedTotal, Number(pricingConfig.minimum_price || 0));
  const profit = totalCharged - totalReal;
  const margin = totalCharged > 0 ? (profit / totalCharged) * 100 : 0;

  return {
    filament: {
      real: +filamentReal.toFixed(2),
      charged: +filamentCharged.toFixed(2),
      profit: +(filamentCharged - filamentReal).toFixed(2),
    },
    electricity: {
      real: +elecReal.toFixed(2),
      charged: +elecCharged.toFixed(2),
      profit: +(elecCharged - elecReal).toFixed(2),
    },
    printer_usage: {
      real: +printerReal.toFixed(2),
      charged: +printerCharged.toFixed(2),
      profit: +(printerCharged - printerReal).toFixed(2),
    },
    totals: {
      real: +totalReal.toFixed(2),
      charged: +totalCharged.toFixed(2),
      profit: +profit.toFixed(2),
      margin: +margin.toFixed(1),
    },
    per_printer: perPrinterBreakdown,
    formula_error: formulaError,
    recommendation: {
      lowest_cost: printers.length === 1 ? PRINTER_DB[printers[0].id]?.name : (PRINTER_DB.neptune4._p.base < PRINTER_DB.bambuA1._p.base ? "Neptune 4" : "Bambu Lab A1 Combo"),
      fastest: PRINTER_DB.bambuA1._p.eff > PRINTER_DB.neptune4._p.eff ? "Bambu Lab A1 Combo" : "Neptune 4",
      highest_profit: PRINTER_DB.bambuA1._p.mult > PRINTER_DB.neptune4._p.mult ? "Bambu Lab A1 Combo" : "Neptune 4",
    },
  };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 8);
const fmt = (n) => typeof n === "number" ? `₱${n.toFixed(2)}` : "—";
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ─── STEPS CONFIG ─────────────────────────────────────────────────────────────
const STEPS = [
  { id: 1, label: "Job Type" },
  { id: 2, label: "Printers" },
  { id: 3, label: "Filament" },
  { id: 4, label: "Parameters" },
  { id: 5, label: "Cost Engine" },
  { id: 6, label: "Pricing" },
  { id: 7, label: "Metadata" },
  { id: 8, label: "Confirm" },
];

const JOB_TYPES = ["Standard Print", "Prototype", "Production Run", "Multicolor", "Functional Part", "Display Model"];

// ─── STYLES ───────────────────────────────────────────────────────────────────
const css = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
* { box-sizing: border-box; margin: 0; padding: 0; }
body, #root { background: ${T.bg}; min-height: 100vh; font-family: ${T.fontSans}; color: ${T.text}; }
.app { display: flex; height: 100vh; overflow: hidden; }
.sidebar { width: 220px; min-width: 220px; background: ${T.bgCard}; border-right: 1px solid ${T.border}; display: flex; flex-direction: column; }
.main { flex: 1; overflow-y: auto; padding: 32px; }
.logo { padding: 24px 20px 20px; border-bottom: 1px solid ${T.border}; }
.logo-mark { font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: ${T.accent}; font-family: ${T.fontMono}; }
.logo-name { font-size: 17px; font-weight: 600; color: ${T.text}; margin-top: 4px; }
.nav-section { padding: 16px 12px; flex: 1; }
.nav-label { font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: ${T.textDim}; padding: 0 8px; margin-bottom: 8px; }
.nav-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; cursor: pointer; font-size: 13px; color: ${T.textMuted}; transition: all 0.15s; margin-bottom: 2px; }
.nav-item:hover { background: rgba(255,255,255,0.04); color: ${T.text}; }
.nav-item.active { background: ${T.accentGlow}; color: ${T.accent}; }
.nav-dot { width: 7px; height: 7px; border-radius: 50%; background: ${T.textDim}; }
.nav-item.active .nav-dot { background: ${T.accent}; }
.stepper { display: flex; align-items: center; gap: 0; margin-bottom: 32px; }
.step-item { display: flex; align-items: center; gap: 0; }
.step-circle { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; font-family: ${T.fontMono}; border: 1.5px solid ${T.border}; color: ${T.textDim}; background: ${T.bgCard}; transition: all 0.2s; flex-shrink: 0; }
.step-circle.done { border-color: ${T.accentDim}; background: ${T.accentDim}; color: #000; }
.step-circle.active { border-color: ${T.accent}; color: ${T.accent}; background: ${T.accentGlow}; box-shadow: 0 0 0 3px rgba(0,229,160,0.15); }
.step-label { font-size: 11px; color: ${T.textDim}; margin: 0 6px; white-space: nowrap; display: none; }
.step-label.active { color: ${T.accent}; display: block; }
.step-connector { width: 24px; height: 1px; background: ${T.border}; flex-shrink: 0; }
.step-connector.done { background: ${T.accentDim}; }
.card { background: ${T.bgCard}; border: 1px solid ${T.border}; border-radius: 14px; padding: 24px; margin-bottom: 20px; }
.card-title { font-size: 13px; font-weight: 600; color: ${T.textMuted}; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
.card-title-dot { width: 6px; height: 6px; border-radius: 50%; background: ${T.accent}; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
.grid4 { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 10px; }
.chip { padding: 8px 14px; border-radius: 8px; border: 1.5px solid ${T.border}; font-size: 13px; cursor: pointer; transition: all 0.15s; color: ${T.textMuted}; background: transparent; text-align: center; }
.chip:hover { border-color: ${T.borderHi}; color: ${T.text}; }
.chip.selected { border-color: ${T.accent}; color: ${T.accent}; background: ${T.accentGlow}; }
.chip-printer { padding: 14px 16px; border-radius: 10px; border: 1.5px solid ${T.border}; cursor: pointer; transition: all 0.15s; background: ${T.bgInput}; }
.chip-printer:hover { border-color: ${T.borderHi}; }
.chip-printer.selected { border-color: ${T.accent}; background: ${T.accentGlow}; }
.printer-name { font-size: 14px; font-weight: 500; color: ${T.text}; }
.printer-meta { font-size: 11px; color: ${T.textMuted}; margin-top: 3px; font-family: ${T.fontMono}; }
.badge { padding: 2px 7px; border-radius: 5px; font-size: 10px; font-weight: 600; letter-spacing: 0.5px; }
.badge-accent { background: ${T.accentGlow}; color: ${T.accent}; }
.badge-warn { background: rgba(245,166,35,0.15); color: ${T.warn}; }
.badge-info { background: rgba(91,156,246,0.15); color: ${T.info}; }
.badge-purple { background: rgba(155,125,255,0.15); color: ${T.purple}; }
label { font-size: 12px; color: ${T.textMuted}; display: block; margin-bottom: 6px; letter-spacing: 0.3px; }
input[type=text], input[type=number], input[type=date], select, textarea {
  width: 100%; padding: 9px 12px; background: ${T.bgInput}; border: 1px solid ${T.border};
  border-radius: 8px; color: ${T.text}; font-size: 13px; font-family: ${T.fontSans};
  outline: none; transition: border 0.15s;
}
input:focus, select:focus, textarea:focus { border-color: ${T.accent}; }
input[type=range] { -webkit-appearance: none; width: 100%; height: 4px; background: ${T.border}; border-radius: 2px; border: none; padding: 0; }
input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%; background: ${T.accent}; cursor: pointer; }
.input-group { margin-bottom: 14px; }
.input-row { display: flex; gap: 12px; margin-bottom: 14px; }
.input-row .input-group { flex: 1; margin-bottom: 0; }
.input-addon { display: flex; align-items: center; }
.input-suffix { padding: 9px 10px; background: ${T.bgInput}; border: 1px solid ${T.border}; border-left: none; border-radius: 0 8px 8px 0; font-size: 12px; color: ${T.textMuted}; white-space: nowrap; }
.input-prefix { padding: 9px 10px; background: ${T.bgInput}; border: 1px solid ${T.border}; border-right: none; border-radius: 8px 0 0 8px; font-size: 12px; color: ${T.textMuted}; }
.input-addon input { border-radius: 0; }
.slider-row { display: flex; align-items: center; gap: 12px; }
.slider-val { font-family: ${T.fontMono}; font-size: 13px; color: ${T.accent}; min-width: 48px; text-align: right; }
.btn { padding: 10px 20px; border-radius: 9px; font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.15s; border: none; font-family: ${T.fontSans}; }
.btn-primary { background: ${T.accent}; color: #000; }
.btn-primary:hover { background: #00f5ae; transform: translateY(-1px); }
.btn-primary:disabled { background: ${T.border}; color: ${T.textDim}; cursor: not-allowed; transform: none; }
.btn-ghost { background: transparent; border: 1px solid ${T.border}; color: ${T.textMuted}; }
.btn-ghost:hover { border-color: ${T.borderHi}; color: ${T.text}; }
.btn-danger { background: transparent; border: 1px solid rgba(255,92,92,0.3); color: ${T.danger}; }
.btn-danger:hover { background: rgba(255,92,92,0.1); }
.btn-row { display: flex; justify-content: space-between; align-items: center; margin-top: 24px; }
.stat-card { background: ${T.bgInput}; border: 1px solid ${T.border}; border-radius: 10px; padding: 14px 16px; }
.stat-label { font-size: 11px; color: ${T.textMuted}; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.8px; }
.stat-val { font-size: 22px; font-weight: 600; color: ${T.text}; font-family: ${T.fontMono}; }
.stat-sub { font-size: 11px; color: ${T.textDim}; margin-top: 3px; }
.stat-profit { color: ${T.accent}; }
.cost-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid ${T.border}; }
.cost-row:last-child { border-bottom: none; }
.cost-name { font-size: 13px; color: ${T.textMuted}; }
.cost-real { font-size: 13px; color: ${T.textDim}; font-family: ${T.fontMono}; }
.cost-charged { font-size: 13px; font-weight: 500; color: ${T.text}; font-family: ${T.fontMono}; }
.cost-profit { font-size: 12px; color: ${T.accent}; font-family: ${T.fontMono}; text-align: right; }
.progress-bar { height: 5px; border-radius: 3px; background: ${T.border}; overflow: hidden; margin-top: 8px; }
.progress-fill { height: 100%; border-radius: 3px; background: ${T.accent}; transition: width 0.5s ease; }
.filament-card { background: ${T.bgInput}; border: 1.5px solid ${T.border}; border-radius: 10px; padding: 13px 15px; cursor: pointer; transition: all 0.15s; }
.filament-card:hover { border-color: ${T.borderHi}; }
.filament-card.selected { border-color: ${T.accent}; background: ${T.accentGlow}; }
.filament-color-dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
.fil-name { font-size: 13px; font-weight: 500; color: ${T.text}; }
.fil-meta { font-size: 11px; color: ${T.textMuted}; margin-top: 2px; }
.alloc-row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid ${T.border}; }
.alloc-row:last-child { border-bottom: none; }
.alloc-name { font-size: 13px; font-weight: 500; color: ${T.text}; min-width: 160px; }
.alloc-pct { font-family: ${T.fontMono}; font-size: 14px; color: ${T.accent}; min-width: 42px; text-align: right; }
.tag { padding: 3px 8px; border-radius: 5px; font-size: 10px; font-weight: 500; background: ${T.border}; color: ${T.textMuted}; margin-right: 4px; }
.receipt { background: #fff; color: #111; border-radius: 10px; padding: 28px 24px; font-family: 'Courier New', monospace; max-width: 360px; margin: 0 auto; }
.receipt h2 { text-align: center; font-size: 15px; font-weight: 700; letter-spacing: 1px; margin-bottom: 4px; }
.receipt .sub { text-align: center; font-size: 11px; color: #555; margin-bottom: 16px; }
.receipt hr { border: none; border-top: 1px dashed #ccc; margin: 12px 0; }
.receipt .r-row { display: flex; justify-content: space-between; font-size: 12px; margin: 4px 0; }
.receipt .r-total { display: flex; justify-content: space-between; font-size: 14px; font-weight: 700; margin-top: 8px; }
.receipt .r-center { text-align: center; font-size: 11px; color: #888; margin-top: 12px; }
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: ${T.bgCard}; border: 1px solid ${T.border}; border-radius: 16px; padding: 28px; width: 480px; max-width: 90vw; }
.modal h3 { font-size: 16px; font-weight: 600; margin-bottom: 20px; }
.page-header { margin-bottom: 28px; }
.page-title { font-size: 24px; font-weight: 600; color: ${T.text}; }
.page-sub { font-size: 13px; color: ${T.textMuted}; margin-top: 4px; }
.error-msg { font-size: 12px; color: ${T.danger}; margin-top: 5px; }
.validation-gate { padding: 10px 14px; background: rgba(255,92,92,0.08); border: 1px solid rgba(255,92,92,0.2); border-radius: 8px; font-size: 12px; color: ${T.danger}; margin-top: 12px; }
.nav-bottom { padding: 16px 12px; border-top: 1px solid ${T.border}; }
.inv-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
.search-box { position: relative; }
.search-box input { padding-left: 32px; }
.search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: ${T.textDim}; font-size: 14px; }
.table { width: 100%; border-collapse: collapse; }
.table th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; color: ${T.textDim}; padding: 8px 12px; text-align: left; border-bottom: 1px solid ${T.border}; }
.table td { font-size: 13px; padding: 10px 12px; border-bottom: 1px solid ${T.border}; color: ${T.textMuted}; }
.table td:first-child { color: ${T.text}; }
.table tr:last-child td { border-bottom: none; }
.alloc-total { font-size: 12px; color: ${T.textDim}; margin-top: 8px; }
.alloc-total span { color: ${T.accent}; font-family: ${T.fontMono}; }
.rec-card { background: ${T.bgInput}; border: 1px solid ${T.border}; border-radius: 10px; padding: 14px 16px; }
.rec-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; color: ${T.textDim}; margin-bottom: 6px; }
.rec-val { font-size: 14px; font-weight: 500; color: ${T.accent}; }
.profit-bar-wrap { display: flex; align-items: center; gap: 10px; margin: 6px 0; }
.profit-bar-label { font-size: 12px; color: ${T.textMuted}; min-width: 90px; }
.profit-bar-track { flex: 1; height: 6px; background: ${T.border}; border-radius: 3px; overflow: hidden; }
.profit-bar-fill { height: 100%; border-radius: 3px; }
.profit-bar-val { font-size: 12px; font-family: ${T.fontMono}; color: ${T.accent}; min-width: 52px; text-align: right; }
.confirm-check { display: flex; align-items: flex-start; gap: 10px; padding: 10px 0; border-bottom: 1px solid ${T.border}; }
.confirm-check:last-child { border-bottom: none; }
.check-icon { color: ${T.accent}; font-size: 14px; margin-top: 1px; flex-shrink: 0; }
.check-label { font-size: 12px; color: ${T.textMuted}; }
.check-val { font-size: 13px; color: ${T.text}; font-weight: 500; margin-top: 2px; }
.tab-row { display: flex; gap: 4px; margin-bottom: 24px; }
.tab { padding: 7px 14px; border-radius: 7px; font-size: 12px; font-weight: 500; cursor: pointer; border: 1px solid ${T.border}; color: ${T.textMuted}; background: transparent; transition: all 0.15s; }
.tab.active { background: ${T.accentGlow}; border-color: ${T.accent}; color: ${T.accent}; }
select option { background: ${T.bgCard}; }

@media (max-width: 860px) {
  body, #root { min-height: 100dvh; }
  .app { display: block; height: auto; min-height: 100dvh; overflow: visible; padding-bottom: 76px; }
  .sidebar { position: fixed; left: 0; right: 0; bottom: 0; top: auto; z-index: 80; width: 100%; min-width: 0; height: 68px; border-right: none; border-top: 1px solid ${T.border}; flex-direction: row; box-shadow: 0 -12px 30px rgba(0,0,0,0.28); }
  .logo, .nav-label, .nav-bottom { display: none; }
  .nav-section { width: 100%; display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; padding: 8px; }
  .nav-item { justify-content: center; text-align: center; font-size: 10px; line-height: 1.1; padding: 8px 4px; margin: 0; border-radius: 12px; min-height: 48px; }
  .nav-dot { display: none; }
  .main { padding: 16px; overflow: visible; }
  .page-title { font-size: 22px; }
  .page-header { margin-bottom: 18px; }
  .stepper { overflow-x: auto; padding-bottom: 8px; margin-bottom: 18px; scrollbar-width: none; }
  .stepper::-webkit-scrollbar { display: none; }
  .step-circle { width: 30px; height: 30px; }
  .step-connector { width: 14px; }
  .card { padding: 16px; border-radius: 18px; margin-bottom: 14px; }
  .grid2, .grid3, .grid4 { grid-template-columns: 1fr !important; }
  .input-row { flex-direction: column; gap: 0; }
  .btn-row { position: sticky; bottom: 78px; z-index: 20; background: linear-gradient(180deg, rgba(13,15,20,0), ${T.bg} 22%); padding-top: 18px; gap: 10px; }
  .btn-row .btn { min-height: 44px; }
  .filament-card, .chip-printer, .chip { border-radius: 14px; }
  .table { min-width: 720px; }
  .card:has(.table) { overflow-x: auto; }
  .modal-overlay { align-items: flex-end; }
  .modal { width: 100%; max-width: none; border-radius: 20px 20px 0 0; padding: 22px; }
  .receipt { max-width: 100%; }
}

@media print {
  body, #root { background: #fff; }
  .sidebar, .page-header, .btn-row, button { display: none !important; }
  .main { padding: 0; }
  .receipt { box-shadow: none; border-radius: 0; }
}
`;

// ─── COLOR MAP FOR FILAMENT DOTS ──────────────────────────────────────────────
const colorMap = { "Jade White": "#e8f5e9", "Onyx Black": "#212121", Gold: "#ffd700", Clear: "#e3f2fd", "Bambu Green": "#4caf50", "Marble White": "#f5f5f5" };
const getFilColor = (color) => colorMap[color] || "#888";

// ─── MAIN APP ────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState("pos"); // pos | inventory | jobs | analytics
  const [step, setStep] = useState(1);
  const [filaments, setFilaments] = useState(DEFAULT_FILAMENTS);
  const [showAddFil, setShowAddFil] = useState(false);
  const [completedJobs, setCompletedJobs] = useState([]);
  const [pricingConfig, setPricingConfig] = useState(DEFAULT_PRICING_CONFIG);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("printforge_pricing_config");
      if (saved) setPricingConfig({ ...DEFAULT_PRICING_CONFIG, ...JSON.parse(saved) });
    } catch (_) {}
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("printforge_pricing_config", JSON.stringify(pricingConfig));
    } catch (_) {}
  }, [pricingConfig]);

  // Job state
  const [jobType, setJobType] = useState("");
  const [selectedPrinters, setSelectedPrinters] = useState([]);
  const [selectedFil, setSelectedFil] = useState(null);
  const [grams, setGrams] = useState(50);
  const [hours, setHours] = useState(3);
  const [costResult, setCostResult] = useState(null);
  const [customPrice, setCustomPrice] = useState(null);
  const [clientName, setClientName] = useState("");
  const [deadline, setDeadline] = useState("");
  const [notes, setNotes] = useState("");
  const [parts, setParts] = useState("");

  const [showReceipt, setShowReceipt] = useState(false);
  const [filSearch, setFilSearch] = useState("");

  // Printer allocation
  const togglePrinter = (id) => {
    setSelectedPrinters(prev => {
      const has = prev.find(p => p.id === id);
      if (has) return prev.filter(p => p.id !== id);
      const newList = [...prev, { id, pct: 100 }];
      return rebalance(newList);
    });
  };
  const rebalance = (list) => {
    if (list.length === 0) return [];
    const eq = Math.floor(100 / list.length);
    const rem = 100 - eq * list.length;
    return list.map((p, i) => ({ ...p, pct: eq + (i === 0 ? rem : 0) }));
  };
  const setPrinterPct = (id, val) => {
    setSelectedPrinters(prev => {
      const idx = prev.findIndex(p => p.id === id);
      if (idx < 0 || prev.length < 2) return prev;
      const newList = prev.map(p => ({ ...p }));
      const delta = val - newList[idx].pct;
      newList[idx].pct = val;
      const others = newList.filter((_, i) => i !== idx);
      const total = others.reduce((s, p) => s + p.pct, 0);
      if (total > 0) {
        others.forEach(p => { p.pct = clamp(Math.round(p.pct - delta * (p.pct / total)), 0, 100); });
      }
      const sum = newList.reduce((s, p) => s + p.pct, 0);
      if (sum !== 100) newList[0].pct += 100 - sum;
      return newList;
    });
  };

  // Validation per step
  const stepValid = useCallback(() => {
    switch (step) {
      case 1: return !!jobType;
      case 2: return selectedPrinters.length > 0;
      case 3: return !!selectedFil;
      case 4: return grams > 0 && hours > 0;
      case 5: return !!costResult;
      case 6: return true;
      case 7: return clientName.trim().length > 0;
      case 8: return true;
      default: return false;
    }
  }, [step, jobType, selectedPrinters, selectedFil, grams, hours, costResult, clientName]);

  // Auto-compute cost on step 5
  useEffect(() => {
    if (step === 5 && selectedFil && grams && hours && selectedPrinters.length > 0) {
      const r = _computeEngine({ printers: selectedPrinters, filament: selectedFil, grams, hours, elecRate: pricingConfig.electricity_rate, pricingConfig });
      setCostResult(r);
      if (r) setCustomPrice(r.totals.charged);
    }
  }, [step, selectedFil, grams, hours, selectedPrinters, pricingConfig]);

  const goNext = () => { if (stepValid()) setStep(s => Math.min(8, s + 1)); };
  const goBack = () => { setStep(s => Math.max(1, s - 1)); if (step <= 5) setCostResult(null); };

  const finalizeJob = () => {
    if (!costResult) return;
    const job = {
      id: uid(),
      date: new Date().toLocaleDateString(),
      jobType, clientName, deadline, notes, parts,
      grams, hours,
      filament: selectedFil,
      printers: selectedPrinters,
      cost: costResult,
      finalPrice: customPrice ?? costResult.totals.charged,
    };
    setCompletedJobs(prev => [job, ...prev]);
    setShowReceipt(true);
  };

  const resetJob = () => {
    setStep(1); setJobType(""); setSelectedPrinters([]); setSelectedFil(null);
    setGrams(50); setHours(3); setCostResult(null); setCustomPrice(null);
    setClientName(""); setDeadline(""); setNotes(""); setParts("");
    setShowReceipt(false);
  };

  const filteredFils = filaments.filter(f => f.active && (filSearch === "" || `${f.brand} ${f.type} ${f.color}`.toLowerCase().includes(filSearch.toLowerCase())));

  return (
    <>
      <style>{css}</style>
      <div className="app">
        {/* SIDEBAR */}
        <aside className="sidebar">
          <div className="logo">
            <div className="logo-mark">3DP · POS</div>
            <div className="logo-name">PrintForge</div>
          </div>
          <div className="nav-section">
            <div className="nav-label">Workflow</div>
            {[{ id: "pos", label: "New Job" }, { id: "jobs", label: "Job History" }, { id: "inventory", label: "Filament Inventory" }, { id: "analytics", label: "Analytics" }, { id: "settings", label: "Pricing" }].map(n => (
              <div key={n.id} className={`nav-item ${view === n.id ? "active" : ""}`} onClick={() => setView(n.id)}>
                <span className="nav-dot" />
                {n.label}
              </div>
            ))}
          </div>
          <div className="nav-bottom">
            <div style={{ fontSize: 11, color: T.textDim, fontFamily: T.fontMono }}>
              {completedJobs.length} jobs total
            </div>
            <div style={{ fontSize: 11, color: T.textDim, marginTop: 2 }}>
              {filaments.filter(f => f.active).length} filaments
            </div>
          </div>
        </aside>

        {/* MAIN CONTENT */}
        <main className="main">
          {view === "pos" && !showReceipt && <POSView step={step} stepValid={stepValid} goNext={goNext} goBack={goBack}
            jobType={jobType} setJobType={setJobType}
            selectedPrinters={selectedPrinters} togglePrinter={togglePrinter} setPrinterPct={setPrinterPct}
            filaments={filteredFils} filSearch={filSearch} setFilSearch={setFilSearch}
            selectedFil={selectedFil} setSelectedFil={setSelectedFil}
            grams={grams} setGrams={setGrams} hours={hours} setHours={setHours}
            costResult={costResult} customPrice={customPrice} setCustomPrice={setCustomPrice}
            clientName={clientName} setClientName={setClientName}
            deadline={deadline} setDeadline={setDeadline}
            notes={notes} setNotes={setNotes}
            parts={parts} setParts={setParts}
            finalizeJob={finalizeJob}
          />}

          {view === "pos" && showReceipt && completedJobs[0] && (
            <ReceiptView job={completedJobs[0]} onNew={resetJob} />
          )}

          {view === "inventory" && <InventoryView filaments={filaments} setFilaments={setFilaments}
            showAddFil={showAddFil} setShowAddFil={setShowAddFil} />}

          {view === "jobs" && <JobsView jobs={completedJobs} />}

          {view === "analytics" && <AnalyticsView jobs={completedJobs} />}
          {view === "settings" && <PricingSettingsView pricingConfig={pricingConfig} setPricingConfig={setPricingConfig} />}
        </main>
      </div>
    </>
  );
}

// ─── POS VIEW ─────────────────────────────────────────────────────────────────
function POSView({ step, stepValid, goNext, goBack, jobType, setJobType, selectedPrinters, togglePrinter, setPrinterPct, filaments, filSearch, setFilSearch, selectedFil, setSelectedFil, grams, setGrams, hours, setHours, costResult, customPrice, setCustomPrice, clientName, setClientName, deadline, setDeadline, notes, setNotes, parts, setParts, finalizeJob }) {
  return (
    <div>
      <div className="page-header">
        <div className="page-title">New Print Job</div>
        <div className="page-sub">Follow the steps to configure and price your job</div>
      </div>

      {/* Stepper */}
      <div className="stepper">
        {STEPS.map((s, i) => (
          <div key={s.id} className="step-item">
            <div className={`step-circle ${step > s.id ? "done" : step === s.id ? "active" : ""}`}>
              {step > s.id ? "✓" : s.id}
            </div>
            <span className={`step-label ${step === s.id ? "active" : ""}`}>{s.label}</span>
            {i < STEPS.length - 1 && <div className={`step-connector ${step > s.id ? "done" : ""}`} />}
          </div>
        ))}
      </div>

      {/* Step Panels */}
      {step === 1 && <Step1 jobType={jobType} setJobType={setJobType} />}
      {step === 2 && <Step2 selectedPrinters={selectedPrinters} togglePrinter={togglePrinter} setPrinterPct={setPrinterPct} />}
      {step === 3 && <Step3 filaments={filaments} filSearch={filSearch} setFilSearch={setFilSearch} selectedFil={selectedFil} setSelectedFil={setSelectedFil} />}
      {step === 4 && <Step4 grams={grams} setGrams={setGrams} hours={hours} setHours={setHours} selectedFil={selectedFil} />}
      {step === 5 && <Step5 costResult={costResult} />}
      {step === 6 && <Step6 costResult={costResult} customPrice={customPrice} setCustomPrice={setCustomPrice} />}
      {step === 7 && <Step7 clientName={clientName} setClientName={setClientName} deadline={deadline} setDeadline={setDeadline} notes={notes} setNotes={setNotes} parts={parts} setParts={setParts} />}
      {step === 8 && <Step8 jobType={jobType} selectedPrinters={selectedPrinters} selectedFil={selectedFil} grams={grams} hours={hours} costResult={costResult} customPrice={customPrice} clientName={clientName} deadline={deadline} notes={notes} parts={parts} />}

      {/* Nav Buttons */}
      <div className="btn-row">
        <button className="btn btn-ghost" onClick={goBack} disabled={step === 1}>← Back</button>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {!stepValid() && step < 8 && <span style={{ fontSize: 12, color: T.danger }}>Complete this step to continue</span>}
          {step < 8 && <button className="btn btn-primary" onClick={goNext} disabled={!stepValid()}>Continue →</button>}
          {step === 8 && <button className="btn btn-primary" onClick={finalizeJob}>Finalize & Print Receipt</button>}
        </div>
      </div>
    </div>
  );
}

function Step1({ jobType, setJobType }) {
  return (
    <div className="card">
      <div className="card-title"><span className="card-title-dot" />Job Type</div>
      <p style={{ fontSize: 13, color: T.textMuted, marginBottom: 16 }}>What kind of print job is this?</p>
      <div className="grid3">
        {JOB_TYPES.map(t => (
          <div key={t} className={`chip ${jobType === t ? "selected" : ""}`} onClick={() => setJobType(t)}>{t}</div>
        ))}
      </div>
    </div>
  );
}

function Step2({ selectedPrinters, togglePrinter, setPrinterPct }) {
  const allocTotal = selectedPrinters.reduce((s, p) => s + p.pct, 0);
  return (
    <div className="card">
      <div className="card-title"><span className="card-title-dot" />Printer Assignment</div>
      <div className="grid2" style={{ marginBottom: 20 }}>
        {Object.values(PRINTER_DB).map(p => (
          <div key={p.id} className={`chip-printer ${selectedPrinters.find(s => s.id === p.id) ? "selected" : ""}`} onClick={() => togglePrinter(p.id)}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div className="printer-name">{p.name}</div>
              <div style={{ display: "flex", gap: 4 }}>
                {p.multicolor && <span className="badge badge-purple">AMS</span>}
                <span className="badge badge-info">{p.wattage}W</span>
              </div>
            </div>
            <div className="printer-meta">{p.brand} · {p.buildVol}</div>
          </div>
        ))}
      </div>
      {selectedPrinters.length > 0 && (
        <>
          <div className="card-title" style={{ marginTop: 8 }}><span className="card-title-dot" />Allocation</div>
          {selectedPrinters.map(sp => {
            const p = PRINTER_DB[sp.id];
            return (
              <div key={sp.id} className="alloc-row">
                <span className="alloc-name">{p.name}</span>
                <div style={{ flex: 1 }}>
                  <input type="range" min={selectedPrinters.length > 1 ? 5 : 100} max={selectedPrinters.length > 1 ? 95 : 100} step={5} value={sp.pct}
                    onChange={e => setPrinterPct(sp.id, +e.target.value)} />
                </div>
                <span className="alloc-pct">{sp.pct}%</span>
              </div>
            );
          })}
          <div className="alloc-total">Total: <span>{allocTotal}%</span> {allocTotal !== 100 && <span style={{ color: T.danger }}>⚠ Must equal 100%</span>}</div>
        </>
      )}
    </div>
  );
}

function Step3({ filaments, filSearch, setFilSearch, selectedFil, setSelectedFil }) {
  return (
    <div className="card">
      <div className="card-title"><span className="card-title-dot" />Filament Selection</div>
      <div className="search-box input-group">
        <span className="search-icon">⌕</span>
        <input type="text" placeholder="Search by brand, type, color…" value={filSearch} onChange={e => setFilSearch(e.target.value)} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {filaments.map(f => (
          <div key={f.id} className={`filament-card ${selectedFil?.id === f.id ? "selected" : ""}`} onClick={() => setSelectedFil(f)}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span className="filament-color-dot" style={{ background: getFilColor(f.color), border: "1px solid rgba(255,255,255,0.1)" }} />
              <span className="fil-name">{f.color}</span>
              <span className="badge badge-info">{f.type}</span>
            </div>
            <div className="fil-meta">{f.brand} · {f.finish} · ₱{f.price_per_kg}/kg</div>
          </div>
        ))}
      </div>
      {filaments.length === 0 && <p style={{ fontSize: 13, color: T.textDim, textAlign: "center", padding: "20px 0" }}>No filaments match your search</p>}
    </div>
  );
}

function Step4({ grams, setGrams, hours, setHours, selectedFil }) {
  return (
    <div className="card">
      <div className="card-title"><span className="card-title-dot" />Print Parameters</div>
      {selectedFil && (
        <div style={{ display: "flex", gap: 8, marginBottom: 20, padding: "10px 14px", background: T.bgInput, borderRadius: 8, alignItems: "center" }}>
          <span className="filament-color-dot" style={{ background: getFilColor(selectedFil.color), border: "1px solid rgba(255,255,255,0.1)" }} />
          <span style={{ fontSize: 13, color: T.text }}>{selectedFil.brand} {selectedFil.type} — {selectedFil.color}</span>
          <span className="badge badge-warn">{selectedFil.finish}</span>
        </div>
      )}
      <div className="input-group">
        <label>Filament Usage</label>
        <div className="slider-row">
          <input type="range" min={1} max={500} step={1} value={grams} onChange={e => setGrams(+e.target.value)} />
          <span className="slider-val">{grams}g</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: T.textDim, marginTop: 4 }}>
          <span>1g</span><span style={{ color: T.textMuted }}>{(grams / 1000 * selectedFil?.price_per_kg || 0).toFixed(2)} ₱ raw material</span><span>500g</span>
        </div>
      </div>
      <div className="input-group" style={{ marginTop: 16 }}>
        <label>Print Duration</label>
        <div className="slider-row">
          <input type="range" min={0.5} max={72} step={0.5} value={hours} onChange={e => setHours(+e.target.value)} />
          <span className="slider-val">{hours}h</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: T.textDim, marginTop: 4 }}>
          <span>0.5h</span><span style={{ color: T.textMuted }}>{(hours * 60).toFixed(0)} minutes</span><span>72h</span>
        </div>
      </div>
      <div className="grid2" style={{ marginTop: 20 }}>
        <div className="stat-card">
          <div className="stat-label">Weight</div>
          <div className="stat-val">{grams}g</div>
          <div className="stat-sub">{(grams / 1000).toFixed(3)} kg</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Time</div>
          <div className="stat-val">{hours}h</div>
          <div className="stat-sub">{(hours * 60).toFixed(0)} min</div>
        </div>
      </div>
    </div>
  );
}

function Step5({ costResult }) {
  if (!costResult) return <div className="card"><p style={{ color: T.textMuted, fontSize: 13 }}>Computing costs…</p></div>;
  const items = [
    { label: "Filament", ...costResult.filament },
    { label: "Electricity", ...costResult.electricity },
    { label: "Printer Usage", ...costResult.printer_usage },
  ];
  const maxProfit = Math.max(...items.map(i => i.profit));
  return (
    <div>
      <div className="card">
        <div className="card-title"><span className="card-title-dot" />Cost Breakdown</div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 0 }}>
          <div style={{ fontSize: 11, color: T.textDim, padding: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.8px" }}>Component</div>
          <div style={{ fontSize: 11, color: T.textDim, padding: "0 0 8px", textAlign: "right", textTransform: "uppercase", letterSpacing: "0.8px" }}>Real Cost</div>
          <div style={{ fontSize: 11, color: T.textDim, padding: "0 0 8px", textAlign: "right", textTransform: "uppercase", letterSpacing: "0.8px" }}>Charged</div>
          <div style={{ fontSize: 11, color: T.textDim, padding: "0 0 8px", textAlign: "right", textTransform: "uppercase", letterSpacing: "0.8px" }}>Profit</div>
        </div>
        {items.map(item => (
          <div key={item.label}>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 0, padding: "10px 0", borderTop: `1px solid ${T.border}` }}>
              <span className="cost-name">{item.label}</span>
              <span className="cost-real" style={{ textAlign: "right" }}>₱{item.real.toFixed(2)}</span>
              <span className="cost-charged" style={{ textAlign: "right" }}>₱{item.charged.toFixed(2)}</span>
              <span className="cost-profit" style={{ textAlign: "right" }}>+₱{item.profit.toFixed(2)}</span>
            </div>
            <div className="profit-bar-wrap">
              <div className="profit-bar-track" style={{ flex: 1 }}>
                <div className="profit-bar-fill" style={{ width: `${maxProfit > 0 ? (item.profit / maxProfit * 100) : 0}%`, background: T.accent }} />
              </div>
            </div>
          </div>
        ))}
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 0, padding: "12px 0 0", borderTop: `2px solid ${T.accent}`, marginTop: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Total</span>
          <span style={{ textAlign: "right", fontSize: 13, color: T.textDim, fontFamily: T.fontMono }}>₱{costResult.totals.real.toFixed(2)}</span>
          <span style={{ textAlign: "right", fontSize: 13, fontWeight: 600, color: T.text, fontFamily: T.fontMono }}>₱{costResult.totals.charged.toFixed(2)}</span>
          <span style={{ textAlign: "right", fontSize: 13, fontWeight: 600, color: T.accent, fontFamily: T.fontMono }}>+₱{costResult.totals.profit.toFixed(2)}</span>
        </div>
      </div>
      {costResult.formula_error && (
        <div className="validation-gate" style={{ marginBottom: 16 }}>
          Pricing formula warning: {costResult.formula_error}
        </div>
      )}
      <div className="card">
        <div className="card-title"><span className="card-title-dot" />Recommendation</div>
        <div className="grid3">
          <div className="rec-card"><div className="rec-title">Lowest Cost</div><div className="rec-val">{costResult.recommendation.lowest_cost}</div></div>
          <div className="rec-card"><div className="rec-title">Fastest</div><div className="rec-val">{costResult.recommendation.fastest}</div></div>
          <div className="rec-card"><div className="rec-title">Highest Profit</div><div className="rec-val">{costResult.recommendation.highest_profit}</div></div>
        </div>
      </div>
    </div>
  );
}

function Step6({ costResult, customPrice, setCustomPrice }) {
  if (!costResult) return null;
  const finalPrice = customPrice ?? costResult.totals.charged;
  const profit = finalPrice - costResult.totals.real;
  const margin = finalPrice > 0 ? (profit / finalPrice * 100) : 0;
  return (
    <div className="card">
      <div className="card-title"><span className="card-title-dot" />Pricing Review</div>
      <div className="grid2" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">Suggested Price</div>
          <div className="stat-val">₱{costResult.totals.charged.toFixed(2)}</div>
          <div className="stat-sub">System recommendation</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Your Price</div>
          <div className="stat-val stat-profit">₱{finalPrice.toFixed(2)}</div>
          <div className="stat-sub">Editable below</div>
        </div>
      </div>
      <div className="input-group">
        <label>Final Price (₱)</label>
        <div className="input-addon">
          <span className="input-prefix">₱</span>
          <input type="number" value={finalPrice} min={0} step={0.5} onChange={e => setCustomPrice(+e.target.value)} style={{ borderRadius: "0 8px 8px 0" }} />
        </div>
      </div>
      <div style={{ marginTop: 16, padding: "12px 16px", background: T.bgInput, borderRadius: 9 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: T.textMuted }}>Profit at this price</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: profit >= 0 ? T.accent : T.danger, fontFamily: T.fontMono }}>₱{profit.toFixed(2)}</span>
        </div>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${clamp(margin, 0, 100)}%`, background: margin < 20 ? T.warn : T.accent }} />
        </div>
        <div style={{ fontSize: 11, color: T.textDim, marginTop: 4 }}>{margin.toFixed(1)}% margin</div>
      </div>
    </div>
  );
}

function Step7({ clientName, setClientName, deadline, setDeadline, notes, setNotes, parts, setParts }) {
  return (
    <div className="card">
      <div className="card-title"><span className="card-title-dot" />Job Metadata</div>
      <div className="input-row">
        <div className="input-group">
          <label>Client Name *</label>
          <input type="text" placeholder="e.g. Maria Santos" value={clientName} onChange={e => setClientName(e.target.value)} />
          {!clientName.trim() && <div className="error-msg">Required</div>}
        </div>
        <div className="input-group">
          <label>Deadline</label>
          <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)} />
        </div>
      </div>
      <div className="input-group">
        <label>Parts / Items</label>
        <input type="text" placeholder="e.g. 3x bracket, 1x base" value={parts} onChange={e => setParts(e.target.value)} />
      </div>
      <div className="input-group">
        <label>Notes</label>
        <textarea rows={3} placeholder="Special instructions, color requirements…" value={notes} onChange={e => setNotes(e.target.value)} style={{ resize: "none" }} />
      </div>
    </div>
  );
}

function Step8({ jobType, selectedPrinters, selectedFil, grams, hours, costResult, customPrice, clientName, deadline, notes, parts }) {
  const finalPrice = customPrice ?? costResult?.totals.charged;
  const checks = [
    { label: "Job Type", val: jobType },
    { label: "Printers", val: selectedPrinters.map(p => `${PRINTER_DB[p.id]?.name} (${p.pct}%)`).join(", ") },
    { label: "Filament", val: selectedFil ? `${selectedFil.brand} ${selectedFil.type} — ${selectedFil.color}` : "—" },
    { label: "Parameters", val: `${grams}g · ${hours}h` },
    { label: "Total Cost", val: finalPrice ? `₱${finalPrice.toFixed(2)}` : "—" },
    { label: "Client", val: clientName },
    { label: "Deadline", val: deadline || "None" },
    { label: "Parts", val: parts || "Not specified" },
  ];
  return (
    <div className="card">
      <div className="card-title"><span className="card-title-dot" />Final Confirmation</div>
      {checks.map(c => (
        <div key={c.label} className="confirm-check">
          <span className="check-icon">✓</span>
          <div>
            <div className="check-label">{c.label}</div>
            <div className="check-val">{c.val}</div>
          </div>
        </div>
      ))}
      <div style={{ marginTop: 16, padding: "10px 14px", background: T.accentGlow, border: `1px solid ${T.accentDim}`, borderRadius: 8, fontSize: 13, color: T.accent }}>
        Ready to finalize. Click "Finalize & Print Receipt" to complete.
      </div>
    </div>
  );
}

// ─── RECEIPT VIEW ─────────────────────────────────────────────────────────────
function ReceiptView({ job, onNew }) {
  const finalPrice = job.finalPrice;
  const now = new Date();
  return (
    <div>
      <div className="page-header">
        <div className="page-title">Job Complete</div>
        <div className="page-sub">Receipt generated for {job.clientName}</div>
      </div>
      <div className="receipt">
        <h2>PRINTFORGE</h2>
        <div className="sub">3D Print Receipt</div>
        <div className="sub">{now.toLocaleDateString()} · {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
        <hr />
        <div className="r-row"><span>Client</span><span>{job.clientName}</span></div>
        <div className="r-row"><span>Job Type</span><span>{job.jobType}</span></div>
        {job.deadline && <div className="r-row"><span>Deadline</span><span>{job.deadline}</span></div>}
        <hr />
        <div className="r-row"><span>Filament Used</span><span>{job.grams}g</span></div>
        <div className="r-row"><span>Print Time</span><span>{job.hours}h</span></div>
        {job.parts && <div className="r-row"><span>Parts</span><span style={{ maxWidth: 160, textAlign: "right", wordBreak: "break-word" }}>{job.parts}</span></div>}
        <hr />
        <div className="r-row"><span>Printers Used</span><span>{job.printers.map(p => PRINTER_DB[p.id]?.name).join(", ")}</span></div>
        <div className="r-row"><span>Filament</span><span>{job.filament?.type} {job.filament?.color}</span></div>
        <hr />
        <div className="r-total"><span>TOTAL</span><span>₱{finalPrice.toFixed(2)}</span></div>
        <div className="r-center">Thank you for your order!</div>
        <div className="r-center" style={{ marginTop: 4 }}>Job ID: {job.id.toUpperCase()}</div>
      </div>
      <div style={{ display: "flex", justifyContent: "center", gap: 12, marginTop: 24 }}>
        <button className="btn btn-ghost" onClick={() => window.print()}>Print Receipt</button>
        <button className="btn btn-primary" onClick={onNew}>New Job →</button>
      </div>
    </div>
  );
}

// ─── INVENTORY VIEW ───────────────────────────────────────────────────────────
function InventoryView({ filaments, setFilaments, showAddFil, setShowAddFil }) {
  const [editFil, setEditFil] = useState(null);
  const [form, setForm] = useState({ brand: "", type: "PLA", color: "", finish: "matte", price_per_kg: 25, active: true });

  const openAdd = () => { setForm({ brand: "", type: "PLA", color: "", finish: "matte", price_per_kg: 25, active: true }); setEditFil(null); setShowAddFil(true); };
  const openEdit = (f) => { setForm({ ...f }); setEditFil(f.id); setShowAddFil(true); };
  const openDupe = (f) => { setForm({ ...f, id: undefined, color: f.color + " (Copy)" }); setEditFil(null); setShowAddFil(true); };
  const saveFilament = () => {
    if (!form.brand || !form.color) return;
    if (editFil) {
      setFilaments(prev => prev.map(f => f.id === editFil ? { ...form, id: editFil } : f));
    } else {
      setFilaments(prev => [...prev, { ...form, id: uid() }]);
    }
    setShowAddFil(false);
  };
  const toggleActive = (id) => setFilaments(prev => prev.map(f => f.id === id ? { ...f, active: !f.active } : f));
  const removeFilament = (id) => setFilaments(prev => prev.filter(f => f.id !== id));

  return (
    <div>
      <div className="inv-header">
        <div>
          <div className="page-title">Filament Inventory</div>
          <div className="page-sub">{filaments.filter(f => f.active).length} active filaments</div>
        </div>
        <button className="btn btn-primary" onClick={openAdd}>+ Add Filament</button>
      </div>
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Filament</th><th>Type</th><th>Finish</th><th>₱/kg</th><th>Status</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filaments.map(f => (
              <tr key={f.id}>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="filament-color-dot" style={{ background: getFilColor(f.color), border: "1px solid rgba(255,255,255,0.15)" }} />
                    <div><div style={{ color: T.text, fontWeight: 500 }}>{f.color}</div><div style={{ fontSize: 11, color: T.textDim }}>{f.brand}</div></div>
                  </div>
                </td>
                <td><span className="badge badge-info">{f.type}</span></td>
                <td><span className="tag">{f.finish}</span></td>
                <td style={{ fontFamily: T.fontMono }}>₱{f.price_per_kg}</td>
                <td>
                  <span className={`badge ${f.active ? "badge-accent" : ""}`} onClick={() => toggleActive(f.id)} style={{ cursor: "pointer", ...(f.active ? {} : { background: T.border, color: T.textDim }) }}>
                    {f.active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => openEdit(f)}>Edit</button>
                    <button className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => openDupe(f)}>Dupe</button>
                    <button className="btn btn-danger" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => removeFilament(f.id)}>✕</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showAddFil && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowAddFil(false)}>
          <div className="modal">
            <h3>{editFil ? "Edit Filament" : "Add Filament"}</h3>
            <div className="input-row">
              <div className="input-group"><label>Brand</label><input type="text" value={form.brand} onChange={e => setForm(f => ({ ...f, brand: e.target.value }))} placeholder="e.g. Bambu Lab" /></div>
              <div className="input-group"><label>Color Name</label><input type="text" value={form.color} onChange={e => setForm(f => ({ ...f, color: e.target.value }))} placeholder="e.g. Jade White" /></div>
            </div>
            <div className="input-row">
              <div className="input-group"><label>Type</label>
                <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
                  {["PLA", "PLA+", "Silk", "PETG"].map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div className="input-group"><label>Finish</label>
                <select value={form.finish} onChange={e => setForm(f => ({ ...f, finish: e.target.value }))}>
                  {["matte", "glossy", "silk", "metallic"].map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
            </div>
            <div className="input-group"><label>Price per kg (₱)</label><input type="number" value={form.price_per_kg} min={1} onChange={e => setForm(f => ({ ...f, price_per_kg: +e.target.value }))} /></div>
            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setShowAddFil(false)}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={saveFilament} disabled={!form.brand || !form.color}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── PRICING SETTINGS VIEW ───────────────────────────────────────────────────
function PricingSettingsView({ pricingConfig, setPricingConfig }) {
  const [draft, setDraft] = useState(pricingConfig);
  const [testError, setTestError] = useState("");
  const [testPrice, setTestPrice] = useState(null);

  useEffect(() => {
    setDraft(pricingConfig);
  }, [pricingConfig]);

  const update = (key, value) => setDraft((current) => ({ ...current, [key]: value }));

  const testFormula = () => {
    try {
      const result = _evaluatePricingFormula(draft.formula, {
        grams: 100,
        hours: 4,
        filament_real: 65,
        filament_charged: 120,
        electricity_real: 16.8,
        electricity_charged: 25,
        printer_real: 80,
        printer_charged: 150,
        real_total: 161.8,
        default_charged_total: 295,
        markup_multiplier: Number(draft.markup_multiplier || 1),
        minimum_price: Number(draft.minimum_price || 0),
      });
      setTestError("");
      setTestPrice(Math.max(result, Number(draft.minimum_price || 0)));
    } catch (err) {
      setTestPrice(null);
      setTestError(err.message || "Formula error");
    }
  };

  const save = () => {
    setPricingConfig({
      ...draft,
      electricity_rate: Number(draft.electricity_rate || 0),
      minimum_price: Number(draft.minimum_price || 0),
      markup_multiplier: Number(draft.markup_multiplier || 1),
    });
    testFormula();
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Pricing Formula</div>
        <div className="page-sub">Admin-only pricing controls. This is not shown on customer receipts.</div>
      </div>
      <div className="grid2">
        <div className="card">
          <div className="card-title"><span className="card-title-dot" />Editable Formula</div>
          <div className="input-group">
            <label>Formula</label>
            <textarea rows={5} value={draft.formula} onChange={e => update("formula", e.target.value)} style={{ fontFamily: T.fontMono, resize: "vertical" }} />
            {testError && <div className="error-msg">{testError}</div>}
          </div>
          <div className="input-row">
            <div className="input-group">
              <label>Markup Multiplier</label>
              <input type="number" step="0.05" value={draft.markup_multiplier} onChange={e => update("markup_multiplier", +e.target.value)} />
            </div>
            <div className="input-group">
              <label>Minimum Price</label>
              <input type="number" step="1" value={draft.minimum_price} onChange={e => update("minimum_price", +e.target.value)} />
            </div>
          </div>
          <div className="input-group">
            <label>Electricity Rate / kWh</label>
            <input type="number" step="0.01" value={draft.electricity_rate} onChange={e => update("electricity_rate", +e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={testFormula}>Test Formula</button>
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={save}>Save Pricing</button>
          </div>
          {testPrice !== null && (
            <div style={{ marginTop: 16, padding: "12px 16px", background: T.accentGlow, border: `1px solid ${T.accentDim}`, borderRadius: 9, fontSize: 13, color: T.accent }}>
              Test output: ₱{testPrice.toFixed(2)} using sample 100g / 4h data.
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-title"><span className="card-title-dot" />Allowed Variables</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {["grams", "hours", "filament_real", "filament_charged", "electricity_real", "electricity_charged", "printer_real", "printer_charged", "real_total", "default_charged_total", "markup_multiplier", "minimum_price"].map(v => (
              <span key={v} className="tag" style={{ fontFamily: T.fontMono, padding: "6px 9px" }}>{v}</span>
            ))}
          </div>
          <div style={{ marginTop: 18 }}>
            <div className="card-title"><span className="card-title-dot" />Examples</div>
            <div className="rec-card" style={{ marginBottom: 10 }}>
              <div className="rec-title">Simple markup</div>
              <div className="rec-val" style={{ fontFamily: T.fontMono, wordBreak: "break-word" }}>default_charged_total * markup_multiplier</div>
            </div>
            <div className="rec-card" style={{ marginBottom: 10 }}>
              <div className="rec-title">Cost-plus target</div>
              <div className="rec-val" style={{ fontFamily: T.fontMono, wordBreak: "break-word" }}>real_total * 2.2</div>
            </div>
            <div className="rec-card">
              <div className="rec-title">Weight and time based</div>
              <div className="rec-val" style={{ fontFamily: T.fontMono, wordBreak: "break-word" }}>(grams * 2.5) + (hours * 35)</div>
            </div>
          </div>
          <div className="validation-gate" style={{ color: T.warn, borderColor: "rgba(245,166,35,0.25)", background: "rgba(245,166,35,0.08)" }}>
            For real production security, move formula evaluation to a backend API and restrict this page to admin accounts.
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── JOBS VIEW ────────────────────────────────────────────────────────────────
function JobsView({ jobs }) {
  if (jobs.length === 0) return (
    <div>
      <div className="page-header"><div className="page-title">Job History</div></div>
      <div className="card" style={{ textAlign: "center", padding: "48px 24px" }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>◷</div>
        <div style={{ fontSize: 14, color: T.textMuted }}>No jobs completed yet</div>
        <div style={{ fontSize: 12, color: T.textDim, marginTop: 4 }}>Complete a job via New Job to see it here</div>
      </div>
    </div>
  );
  const total = jobs.reduce((s, j) => s + j.finalPrice, 0);
  const totalProfit = jobs.reduce((s, j) => s + (j.cost?.totals.profit ?? 0), 0);
  return (
    <div>
      <div className="page-header"><div className="page-title">Job History</div><div className="page-sub">{jobs.length} jobs completed</div></div>
      <div className="grid2" style={{ marginBottom: 20 }}>
        <div className="stat-card"><div className="stat-label">Total Revenue</div><div className="stat-val">₱{total.toFixed(2)}</div></div>
        <div className="stat-card"><div className="stat-label">Total Profit</div><div className="stat-val stat-profit">₱{totalProfit.toFixed(2)}</div></div>
      </div>
      <div className="card">
        <table className="table">
          <thead><tr><th>ID</th><th>Date</th><th>Client</th><th>Type</th><th>Params</th><th>Revenue</th><th>Profit</th></tr></thead>
          <tbody>
            {jobs.map(j => (
              <tr key={j.id}>
                <td style={{ fontFamily: T.fontMono, fontSize: 11 }}>{j.id.toUpperCase()}</td>
                <td>{j.date}</td>
                <td style={{ fontWeight: 500, color: T.text }}>{j.clientName}</td>
                <td><span className="tag">{j.jobType}</span></td>
                <td style={{ fontFamily: T.fontMono, fontSize: 11 }}>{j.grams}g · {j.hours}h</td>
                <td style={{ fontFamily: T.fontMono, color: T.text }}>₱{j.finalPrice.toFixed(2)}</td>
                <td style={{ fontFamily: T.fontMono, color: T.accent }}>+₱{(j.cost?.totals.profit ?? 0).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── ANALYTICS VIEW ───────────────────────────────────────────────────────────
function AnalyticsView({ jobs }) {
  if (jobs.length === 0) return (
    <div>
      <div className="page-header"><div className="page-title">Analytics</div></div>
      <div className="card" style={{ textAlign: "center", padding: "48px" }}>
        <div style={{ fontSize: 14, color: T.textMuted }}>Complete jobs to see analytics</div>
      </div>
    </div>
  );

  const totalRev = jobs.reduce((s, j) => s + j.finalPrice, 0);
  const totalCost = jobs.reduce((s, j) => s + (j.cost?.totals.real ?? 0), 0);
  const totalProfit = jobs.reduce((s, j) => s + (j.cost?.totals.profit ?? 0), 0);
  const avgMargin = jobs.length > 0 ? jobs.reduce((s, j) => s + (j.cost?.totals.margin ?? 0), 0) / jobs.length : 0;

  const byType = {};
  jobs.forEach(j => { byType[j.jobType] = (byType[j.jobType] || 0) + 1; });
  const maxTypeCount = Math.max(...Object.values(byType));

  const filamentProfit = jobs.reduce((s, j) => s + (j.cost?.filament.profit ?? 0), 0);
  const elecProfit = jobs.reduce((s, j) => s + (j.cost?.electricity.profit ?? 0), 0);
  const printerProfit = jobs.reduce((s, j) => s + (j.cost?.printer_usage.profit ?? 0), 0);
  const maxProfit2 = Math.max(filamentProfit, elecProfit, printerProfit);

  return (
    <div>
      <div className="page-header"><div className="page-title">Analytics</div><div className="page-sub">Profit engine summary</div></div>
      <div className="grid4" style={{ marginBottom: 20 }}>
        <div className="stat-card"><div className="stat-label">Revenue</div><div className="stat-val">₱{totalRev.toFixed(0)}</div></div>
        <div className="stat-card"><div className="stat-label">Real Cost</div><div className="stat-val">₱{totalCost.toFixed(0)}</div></div>
        <div className="stat-card"><div className="stat-label">Total Profit</div><div className="stat-val stat-profit">₱{totalProfit.toFixed(0)}</div></div>
        <div className="stat-card"><div className="stat-label">Avg Margin</div><div className="stat-val">{avgMargin.toFixed(1)}%</div></div>
      </div>
      <div className="grid2">
        <div className="card">
          <div className="card-title"><span className="card-title-dot" />Profit by Component</div>
          {[["Filament", filamentProfit], ["Electricity", elecProfit], ["Printer Usage", printerProfit]].map(([label, val]) => (
            <div key={label} className="profit-bar-wrap">
              <span className="profit-bar-label">{label}</span>
              <div className="profit-bar-track">
                <div className="profit-bar-fill" style={{ width: `${maxProfit2 > 0 ? (val / maxProfit2 * 100) : 0}%`, background: T.accent }} />
              </div>
              <span className="profit-bar-val">₱{val.toFixed(2)}</span>
            </div>
          ))}
        </div>
        <div className="card">
          <div className="card-title"><span className="card-title-dot" />Jobs by Type</div>
          {Object.entries(byType).map(([t, c]) => (
            <div key={t} className="profit-bar-wrap">
              <span className="profit-bar-label" style={{ fontSize: 11 }}>{t}</span>
              <div className="profit-bar-track">
                <div className="profit-bar-fill" style={{ width: `${(c / maxTypeCount * 100)}%`, background: T.purple }} />
              </div>
              <span className="profit-bar-val" style={{ color: T.purple }}>{c}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
