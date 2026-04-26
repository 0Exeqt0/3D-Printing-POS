"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseAnonKey);

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

const DEFAULT_PRICING_CONFIG = {
  electricity_rate: 12,
  minimum_price: 100,
  markup_multiplier: 1.0,
  formula: "default_charged_total * markup_multiplier",
  true_electricity_cost: null,
  selling_electricity_cost: null,
};

function dbPrinterToInternal(row) {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    wattage: Number(row.wattage),
    multicolor: row.multicolor,
    buildVol: row.build_volume,
    _p: {
      base: Number(row.base_rate),
      eff: Number(row.efficiency),
      labor: Number(row.labor),
      mult: Number(row.multiplier),
    },
  };
}

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

function _computeEngine(job, PRINTER_DB) {
  const { printers, filament, grams, hours, elecRate = 0.12, pricingConfig = DEFAULT_PRICING_CONFIG } = job;
  if (!filament || !grams || !hours || !printers?.length) return null;

  const trueCostKg = Number(filament.true_cost_per_kg ?? filament.price_per_kg ?? 0);
  const sellingKg = Number(filament.selling_price_per_kg ?? 0);
  const filamentReal = (grams / 1000) * trueCostKg;
  const filamentCharged = (() => {
    if (sellingKg > 0) return (grams / 1000) * sellingKg;
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
      id: p.id, name: p.name, pct: alloc.pct,
      hours: +pHours.toFixed(2), grams: +pGrams.toFixed(1),
      elec: { real: +er.toFixed(2), charged: +ec.toFixed(2) },
      printer: { real: +pr.toFixed(2), charged: +pc.toFixed(2) },
    });
  }

  const totalReal = filamentReal + elecReal + printerReal;
  const defaultChargedTotal = filamentCharged + elecCharged + printerCharged;
  let formulaError = "";
  let computedChargedTotal = defaultChargedTotal;

  const elecKwh = +(printers.reduce((acc, alloc) => {
    const p = PRINTER_DB[alloc.id]; if (!p) return acc;
    return acc + (p.wattage / 1000) * (hours * alloc.pct / 100);
  }, 0).toFixed(4));

  try {
    // FIX: all aliases defined together so none are undefined in formula
    const formulaVariables = {
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
      filament_price_per_gram: trueCostKg / 1000,
      filament_selling_per_gram: sellingKg > 0 ? sellingKg / 1000 : trueCostKg / 1000,
      true_cost_per_kg: trueCostKg,
      selling_price_per_kg: sellingKg > 0 ? sellingKg : trueCostKg,
      elec_kwh: elecKwh,
      // Aliases — all defined here so formulas referencing any of them work
      machine_rate: printerReal,
      machine_charged: printerCharged,
      filament_cost: filamentReal,
      filament_price: filamentCharged,
      electricity_cost: elecReal,
      electricity_price: elecCharged,
      total_cost: totalReal,
    };
    const formulaPrice = _evaluatePricingFormula(pricingConfig.formula, formulaVariables);
    if (formulaPrice !== null) computedChargedTotal = formulaPrice;
  } catch (err) {
    formulaError = err.message || "Formula error. Using default engine price.";
  }

  const totalCharged = Math.max(computedChargedTotal, Number(pricingConfig.minimum_price || 0));
  const profit = totalCharged - totalReal;
  const margin = totalCharged > 0 ? (profit / totalCharged) * 100 : 0;

  const printerList = Object.values(PRINTER_DB);
  const lowestCost = printers.length === 1
    ? PRINTER_DB[printers[0].id]?.name
    : (printerList.reduce((a, b) => a._p.base < b._p.base ? a : b)?.name ?? "—");
  const fastest = printerList.reduce((a, b) => a._p.eff > b._p.eff ? a : b)?.name ?? "—";
  const highestProfit = printerList.reduce((a, b) => a._p.mult > b._p.mult ? a : b)?.name ?? "—";

  return {
    filament: { real: +filamentReal.toFixed(2), charged: +filamentCharged.toFixed(2), profit: +(filamentCharged - filamentReal).toFixed(2) },
    electricity: { real: +elecReal.toFixed(2), charged: +elecCharged.toFixed(2), profit: +(elecCharged - elecReal).toFixed(2) },
    printer_usage: { real: +printerReal.toFixed(2), charged: +printerCharged.toFixed(2), profit: +(printerCharged - printerReal).toFixed(2) },
    totals: { real: +totalReal.toFixed(2), charged: +totalCharged.toFixed(2), profit: +profit.toFixed(2), margin: +margin.toFixed(1) },
    per_printer: perPrinterBreakdown,
    formula_error: formulaError,
    recommendation: { lowest_cost: lowestCost, fastest, highest_profit: highestProfit },
    _grams: grams,
    _hours: hours,
    _elecKwh: elecKwh,
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function getFilColor(colorName) {
  if (!colorName) return "#888";
  let hash = 0;
  for (let i = 0; i < colorName.length; i++) hash = colorName.charCodeAt(i) + ((hash << 5) - hash);
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 55%, 60%)`;
}

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
.card-title-dot { width: 6px; height: 6px; border-radius: 50%; background: ${T.accent}; flex-shrink: 0; }
.section-divider { border: none; border-top: 1px solid ${T.border}; margin: 20px 0; }
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
.filament-color-dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
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
.loading-screen { display: flex; align-items: center; justify-content: center; height: 100vh; flex-direction: column; gap: 14px; }
.loading-spinner { width: 32px; height: 32px; border: 2px solid ${T.border}; border-top-color: ${T.accent}; border-radius: 50%; animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.db-error { padding: 20px 24px; background: rgba(255,92,92,0.08); border: 1px solid rgba(255,92,92,0.2); border-radius: 10px; font-size: 13px; color: ${T.danger}; margin-bottom: 16px; }
.empty-state { text-align: center; padding: 40px 24px; color: ${T.textDim}; font-size: 13px; }
.cmp-row { padding: 12px 0; border-top: 1px solid ${T.border}; }
.cmp-row:first-child { border-top: none; }
.cmp-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 7px; }
.cmp-label { font-size: 13px; color: ${T.textMuted}; }
.cmp-vals { display: flex; gap: 12px; font-family: ${T.fontMono}; font-size: 12px; }
.cmp-real { color: ${T.textDim}; }
.cmp-charged { color: ${T.text}; font-weight: 600; }
.cmp-profit { color: ${T.accent}; }
.dual-bar { position: relative; height: 8px; background: ${T.border}; border-radius: 4px; overflow: hidden; margin-bottom: 3px; }
.dual-bar-real { position: absolute; left: 0; top: 0; height: 100%; background: ${T.textDim}; border-radius: 4px; transition: width 0.5s ease; opacity: 0.5; }
.dual-bar-charged { position: absolute; left: 0; top: 0; height: 100%; background: ${T.accent}; border-radius: 4px; transition: width 0.5s ease; opacity: 0.75; }
.dual-bar-legend { display: flex; gap: 12px; margin-top: 2px; }
.dual-bar-legend-item { display: flex; align-items: center; gap: 4px; font-size: 10px; color: ${T.textDim}; }
.dual-bar-legend-dot { width: 8px; height: 4px; border-radius: 2px; }
.params-field-row { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid ${T.border}; }
.params-field-row:last-child { border-bottom: none; }
.params-field-info { flex: 1; min-width: 0; }
.params-field-name { font-size: 13px; color: ${T.text}; font-weight: 500; display: flex; align-items: center; gap: 8px; }
.params-field-sub { font-size: 11px; color: ${T.textDim}; margin-top: 2px; font-family: ${T.fontMono}; }
.params-field-input { width: 130px; flex-shrink: 0; }
.confirm-modal { background: ${T.bgCard}; border: 1px solid rgba(255,92,92,0.3); border-radius: 16px; padding: 28px; width: 400px; max-width: 90vw; }
.confirm-modal h3 { font-size: 16px; font-weight: 600; color: ${T.text}; margin-bottom: 10px; }
.confirm-modal p { font-size: 13px; color: ${T.textMuted}; margin-bottom: 20px; line-height: 1.5; }

@media (max-width: 860px) {
  body, #root { min-height: 100dvh; }
  .app { display: block; height: auto; min-height: 100dvh; overflow: visible; padding-bottom: 76px; }
  .sidebar { position: fixed; left: 0; right: 0; bottom: 0; top: auto; z-index: 80; width: 100%; min-width: 0; height: 68px; border-right: none; border-top: 1px solid ${T.border}; flex-direction: row; box-shadow: 0 -12px 30px rgba(0,0,0,0.28); }
  .logo, .nav-label, .nav-bottom { display: none; }
  .nav-section { width: 100%; display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; padding: 8px; }
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
  .modal, .confirm-modal { width: 100%; max-width: none; border-radius: 20px 20px 0 0; padding: 22px; }
  .receipt { max-width: 100%; }
}

@media print {
  body, #root { background: #fff; }
  .sidebar, .page-header, .btn-row, button { display: none !important; }
  .main { padding: 0; }
  .receipt { box-shadow: none; border-radius: 0; }
}
`;

export default function App() {
  const [view, setView] = useState("pos");
  const [step, setStep] = useState(1);
  const [filaments, setFilaments] = useState([]);
  const [printerDB, setPrinterDB] = useState({});
  const [printerRows, setPrinterRows] = useState([]);
  const [pricingConfig, setPricingConfig] = useState(DEFAULT_PRICING_CONFIG);
  const [completedJobs, setCompletedJobs] = useState([]);
  const [jobOrders, setJobOrders] = useState([]);
  const [dbLoading, setDbLoading] = useState(true);
  const [dbError, setDbError] = useState("");

  useEffect(() => {
    async function loadAll() {
      setDbLoading(true);
      setDbError("");
      try {
        const [
          { data: filData, error: filErr },
          { data: prData, error: prErr },
          { data: psData, error: psErr },
          { data: ordersData },
        ] = await Promise.all([
          supabase.from("filaments").select("*").eq("active", true).order("brand"),
          supabase.from("printers").select("*").eq("active", true).order("name"),
          supabase.from("pricing_settings").select("*").eq("id", "default").single(),
          supabase.from("job_orders").select("*").order("deadline", { ascending: true, nullsFirst: false }).then(r => r).catch(() => ({ data: [] })),
        ]);
        if (filErr) throw new Error(`Filaments: ${filErr.message}`);
        if (prErr) throw new Error(`Printers: ${prErr.message}`);
        if (psErr && psErr.code !== "PGRST116") throw new Error(`Pricing: ${psErr.message}`);
        setFilaments(filData || []);
        setPrinterRows(prData || []);
        const dbMap = {};
        for (const row of (prData || [])) dbMap[row.id] = dbPrinterToInternal(row);
        setPrinterDB(dbMap);
        if (ordersData) setJobOrders(ordersData);
        if (psData) {
          setPricingConfig({
            electricity_rate: Number(psData.electricity_rate),
            minimum_price: Number(psData.minimum_price),
            markup_multiplier: Number(psData.markup_multiplier),
            formula: psData.formula,
            true_electricity_cost: psData.true_electricity_cost != null ? Number(psData.true_electricity_cost) : null,
            selling_electricity_cost: psData.selling_electricity_cost != null ? Number(psData.selling_electricity_cost) : null,
          });
        }
      } catch (err) {
        setDbError(err.message || "Failed to load data from database.");
      } finally {
        setDbLoading(false);
      }
    }
    loadAll();
  }, []);

  const reloadFilaments = useCallback(async () => {
    const { data, error } = await supabase.from("filaments").select("*").order("brand");
    if (!error) setFilaments(data || []);
  }, []);

  const reloadPrinters = useCallback(async () => {
    const { data, error } = await supabase.from("printers").select("*").eq("active", true).order("name");
    if (!error) {
      setPrinterRows(data || []);
      const dbMap = {};
      for (const row of (data || [])) dbMap[row.id] = dbPrinterToInternal(row);
      setPrinterDB(dbMap);
    }
  }, []);

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
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [activeOrderId, setActiveOrderId] = useState(null);

  const filteredFils = filaments.filter(
    (f) => f.active && (filSearch === "" || `${f.brand} ${f.type} ${f.color}`.toLowerCase().includes(filSearch.toLowerCase()))
  );

  const togglePrinter = (id) => {
    setSelectedPrinters((prev) => {
      const has = prev.find((p) => p.id === id);
      if (has) return rebalance(prev.filter((p) => p.id !== id));
      return rebalance([...prev, { id, pct: 100 }]);
    });
  };
  const rebalance = (list) => {
    if (list.length === 0) return [];
    const eq = Math.floor(100 / list.length);
    const rem = 100 - eq * list.length;
    return list.map((p, i) => ({ ...p, pct: eq + (i === 0 ? rem : 0) }));
  };
  const setPrinterPct = (id, val) => {
    setSelectedPrinters((prev) => {
      const idx = prev.findIndex((p) => p.id === id);
      if (idx < 0 || prev.length < 2) return prev;
      const newList = prev.map((p) => ({ ...p }));
      const delta = val - newList[idx].pct;
      newList[idx].pct = val;
      const others = newList.filter((_, i) => i !== idx);
      const total = others.reduce((s, p) => s + p.pct, 0);
      if (total > 0) others.forEach((p) => { p.pct = clamp(Math.round(p.pct - delta * (p.pct / total)), 0, 100); });
      const sum = newList.reduce((s, p) => s + p.pct, 0);
      if (sum !== 100) newList[0].pct += 100 - sum;
      return newList;
    });
  };

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

  useEffect(() => {
    if (step === 5 && selectedFil && grams && hours && selectedPrinters.length > 0) {
      const r = _computeEngine({ printers: selectedPrinters, filament: selectedFil, grams, hours, elecRate: pricingConfig.electricity_rate, pricingConfig }, printerDB);
      setCostResult(r);
      if (r) setCustomPrice(r.totals.charged);
    }
  }, [step, selectedFil, grams, hours, selectedPrinters, pricingConfig, printerDB]);

  const goNext = () => { if (stepValid()) setStep((s) => Math.min(8, s + 1)); };
  const goBack = () => { setStep((s) => Math.max(1, s - 1)); if (step <= 5) setCostResult(null); };

  const finalizeJob = async () => {
    if (!costResult) return;
    setSaving(true);
    setSaveError("");
    const finalPrice = customPrice ?? costResult.totals.charged;
    try {
      const { data: jobData, error: jobErr } = await supabase.from("jobs").insert({
        client_name: clientName, job_type: jobType, filament_id: selectedFil.id, parts,
        total_grams: grams, total_hours: hours, charged_total: finalPrice,
        real_total: costResult.totals.real, profit_total: costResult.totals.profit,
        deadline: deadline || null, notes: notes || null, cost_result: costResult,
        payment_status: "unpaid", status: "pending",
      }).select().single();
      if (jobErr) throw new Error(jobErr.message);
      if (selectedPrinters.length > 0) {
        const allocRows = selectedPrinters.map((p) => ({ job_id: jobData.id, printer_id: p.id, percentage: p.pct }));
        const { error: allocErr } = await supabase.from("job_printer_allocations").insert(allocRows);
        if (allocErr) throw new Error(allocErr.message);
      }
      const job = { id: jobData.id, date: new Date().toLocaleDateString(), jobType, clientName, deadline, notes, parts, grams, hours, filament: selectedFil, printers: selectedPrinters, printerDB, cost: costResult, finalPrice };
      setCompletedJobs((prev) => [job, ...prev]);
      if (activeOrderId) {
        await supabase.from("job_orders").update({ status: "Done", updated_at: new Date().toISOString() }).eq("id", activeOrderId);
        setJobOrders((prev) => prev.map((o) => o.id === activeOrderId ? { ...o, status: "Done" } : o));
      }
      setShowReceipt(true);
    } catch (err) {
      setSaveError(err.message || "Failed to save job.");
    } finally {
      setSaving(false);
    }
  };

  const startJobFromOrder = (order) => {
    setStep(1); setJobType(""); setSelectedPrinters([]); setSelectedFil(null);
    setGrams(50); setHours(3); setCostResult(null); setCustomPrice(null);
    setClientName(""); setDeadline(""); setNotes(""); setParts("");
    setShowReceipt(false); setSaveError(""); setActiveOrderId(null);
    if (order.filament_id) {
      const fil = filaments.find((f) => f.id === order.filament_id);
      if (fil) setSelectedFil(fil);
    }
    if (order.printer_id) {
      const hasPrinter = printerRows.find((p) => p.id === order.printer_id);
      if (hasPrinter) setSelectedPrinters([{ id: order.printer_id, pct: 100 }]);
    }
    if (order.estimated_grams) setGrams(Number(order.estimated_grams));
    if (order.estimated_hours) setHours(Number(order.estimated_hours));
    setClientName(order.client_name || "");
    setDeadline(order.deadline || "");
    setNotes(order.description || "");
    setParts(order.title || "");
    setActiveOrderId(order.id);
    setView("pos");
    setStep(1);
  };

  const resetJob = () => {
    setStep(1); setJobType(""); setSelectedPrinters([]); setSelectedFil(null);
    setGrams(50); setHours(3); setCostResult(null); setCustomPrice(null);
    setClientName(""); setDeadline(""); setNotes(""); setParts("");
    setShowReceipt(false); setSaveError(""); setActiveOrderId(null);
  };

  // FIX: "Add New Order" just goes to New Job wizard — no separate form
  const handleAddNewOrder = () => {
    resetJob();
    setView("pos");
  };

  if (dbLoading) {
    return (
      <>
        <style>{css}</style>
        <div className="loading-screen">
          <div className="loading-spinner" />
          <div style={{ fontSize: 13, color: T.textMuted }}>Loading data…</div>
        </div>
      </>
    );
  }

  return (
    <>
      <style>{css}</style>
      <div className="app">
        <aside className="sidebar">
          <div className="logo">
            <div className="logo-mark">3D Printing POS</div>
            <div className="logo-name">TechCraft Innovator</div>
          </div>
          <div className="nav-section">
            <div className="nav-label">Workflow</div>
            {[
              { id: "pos", label: "New Job" },
              { id: "orders", label: "Job Orders" },
              { id: "jobs", label: "Job History" },
              { id: "inventory", label: "Filament Inventory" },
              { id: "parameters", label: "Parameters" },
              { id: "analytics", label: "Analytics" },
              { id: "settings", label: "Pricing" },
            ].map((n) => (
              <div key={n.id} className={`nav-item ${view === n.id ? "active" : ""}`} onClick={() => setView(n.id)}>
                <span className="nav-dot" />
                {n.label}
              </div>
            ))}
          </div>
          <div className="nav-bottom">
            <div style={{ fontSize: 11, color: T.textDim, fontFamily: T.fontMono }}>{completedJobs.length} jobs this session</div>
            <div style={{ fontSize: 11, color: T.textDim, marginTop: 2 }}>{filaments.filter((f) => f.active).length} active filaments</div>
          </div>
        </aside>

        <main className="main">
          {dbError && <div className="db-error">⚠ Database error: {dbError}</div>}

          {view === "pos" && !showReceipt && (
            <POSView
              step={step} stepValid={stepValid} goNext={goNext} goBack={goBack}
              jobType={jobType} setJobType={setJobType}
              selectedPrinters={selectedPrinters} togglePrinter={togglePrinter} setPrinterPct={setPrinterPct} printerDB={printerDB} printerRows={printerRows}
              filaments={filteredFils} filSearch={filSearch} setFilSearch={setFilSearch} selectedFil={selectedFil} setSelectedFil={setSelectedFil}
              grams={grams} setGrams={setGrams} hours={hours} setHours={setHours}
              costResult={costResult} customPrice={customPrice} setCustomPrice={setCustomPrice}
              clientName={clientName} setClientName={setClientName} deadline={deadline} setDeadline={setDeadline}
              notes={notes} setNotes={setNotes} parts={parts} setParts={setParts}
              finalizeJob={finalizeJob} saving={saving} saveError={saveError}
              pricingConfig={pricingConfig} setPricingConfig={setPricingConfig}
              reloadFilaments={reloadFilaments} reloadPrinters={reloadPrinters}
              activeOrderId={activeOrderId} jobOrders={jobOrders}
            />
          )}
          {view === "pos" && showReceipt && completedJobs[0] && <ReceiptView job={completedJobs[0]} onNew={resetJob} />}
          {view === "inventory" && <InventoryView filaments={filaments} setFilaments={setFilaments} reloadFilaments={reloadFilaments} />}
          {view === "parameters" && (
            <ParametersView
              filaments={filaments} printerRows={printerRows} printerDB={printerDB}
              pricingConfig={pricingConfig} setPricingConfig={setPricingConfig}
              reloadFilaments={reloadFilaments} reloadPrinters={reloadPrinters}
              grams={grams} hours={hours} selectedFil={selectedFil} selectedPrinters={selectedPrinters}
            />
          )}
          {view === "orders" && (
            <JobOrdersView
              jobOrders={jobOrders} setJobOrders={setJobOrders}
              filaments={filaments} printerRows={printerRows}
              startJobFromOrder={startJobFromOrder}
              onAddNew={handleAddNewOrder}
            />
          )}
          {view === "jobs" && <JobsView jobs={completedJobs} />}
          {view === "analytics" && <AnalyticsView jobs={completedJobs} />}
          {view === "settings" && <PricingSettingsView pricingConfig={pricingConfig} setPricingConfig={setPricingConfig} />}
        </main>
      </div>
    </>
  );
}

// ─── POS VIEW ─────────────────────────────────────────────────────────────────
function POSView({ step, stepValid, goNext, goBack, jobType, setJobType, selectedPrinters, togglePrinter, setPrinterPct, printerDB, printerRows, filaments, filSearch, setFilSearch, selectedFil, setSelectedFil, grams, setGrams, hours, setHours, costResult, customPrice, setCustomPrice, clientName, setClientName, deadline, setDeadline, notes, setNotes, parts, setParts, finalizeJob, saving, saveError, pricingConfig, setPricingConfig, reloadFilaments, reloadPrinters, activeOrderId, jobOrders }) {
  const activeOrder = activeOrderId ? jobOrders?.find((o) => o.id === activeOrderId) : null;
  return (
    <div>
      <div className="page-header">
        <div className="page-title">New Print Job</div>
        <div className="page-sub">Follow the steps to configure and price your job</div>
      </div>

      {activeOrder && (
        <div style={{ marginBottom: 16, padding: "10px 16px", background: "rgba(91,156,246,0.10)", border: "1px solid rgba(91,156,246,0.3)", borderRadius: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: T.info }}>📋 From Job Order:</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{activeOrder.title}</span>
          <span style={{ fontSize: 12, color: T.textMuted }}>· {activeOrder.client_name}</span>
          {activeOrder.deadline && <span style={{ fontSize: 12, color: T.warn }}>· Due {activeOrder.deadline}</span>}
          <span style={{ marginLeft: "auto", fontSize: 11, color: T.textDim }}>Will mark order Done on finalize</span>
        </div>
      )}

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

      {step === 1 && <Step1 jobType={jobType} setJobType={setJobType} />}
      {step === 2 && <Step2 selectedPrinters={selectedPrinters} togglePrinter={togglePrinter} setPrinterPct={setPrinterPct} printerDB={printerDB} printerRows={printerRows} />}
      {step === 3 && <Step3 filaments={filaments} filSearch={filSearch} setFilSearch={setFilSearch} selectedFil={selectedFil} setSelectedFil={setSelectedFil} />}
      {step === 4 && <Step4 grams={grams} setGrams={setGrams} hours={hours} setHours={setHours} selectedFil={selectedFil} />}
      {step === 5 && <Step5 costResult={costResult} pricingConfig={pricingConfig} selectedFil={selectedFil} />}
      {step === 6 && <Step6 costResult={costResult} customPrice={customPrice} setCustomPrice={setCustomPrice} />}
      {step === 7 && <Step7 clientName={clientName} setClientName={setClientName} deadline={deadline} setDeadline={setDeadline} notes={notes} setNotes={setNotes} parts={parts} setParts={setParts} />}
      {step === 8 && <Step8 jobType={jobType} selectedPrinters={selectedPrinters} printerDB={printerDB} selectedFil={selectedFil} grams={grams} hours={hours} costResult={costResult} customPrice={customPrice} clientName={clientName} deadline={deadline} notes={notes} parts={parts} />}

      {saveError && <div className="validation-gate" style={{ marginTop: 12 }}>Save error: {saveError}</div>}

      <div className="btn-row">
        <button className="btn btn-ghost" onClick={goBack} disabled={step === 1 || saving}>← Back</button>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {!stepValid() && step < 8 && <span style={{ fontSize: 12, color: T.danger }}>Complete this step to continue</span>}
          {step < 8 && <button className="btn btn-primary" onClick={goNext} disabled={!stepValid() || saving}>Continue →</button>}
          {step === 8 && <button className="btn btn-primary" onClick={finalizeJob} disabled={saving}>{saving ? "Saving…" : "Finalize & Print Receipt"}</button>}
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
        {JOB_TYPES.map((t) => (
          <div key={t} className={`chip ${jobType === t ? "selected" : ""}`} onClick={() => setJobType(t)}>{t}</div>
        ))}
      </div>
    </div>
  );
}

function Step2({ selectedPrinters, togglePrinter, setPrinterPct, printerDB, printerRows }) {
  const allocTotal = selectedPrinters.reduce((s, p) => s + p.pct, 0);
  return (
    <div className="card">
      <div className="card-title"><span className="card-title-dot" />Printer Assignment</div>
      {printerRows.length === 0 ? (
        <p style={{ fontSize: 13, color: T.textMuted }}>No active printers found in database.</p>
      ) : (
        <div className="grid2" style={{ marginBottom: 20 }}>
          {printerRows.map((p) => (
            <div key={p.id} className={`chip-printer ${selectedPrinters.find((s) => s.id === p.id) ? "selected" : ""}`} onClick={() => togglePrinter(p.id)}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div className="printer-name">{p.name}</div>
                <div style={{ display: "flex", gap: 4 }}>
                  {p.multicolor && <span className="badge badge-purple">AMS</span>}
                  <span className="badge badge-info">{p.wattage}W</span>
                </div>
              </div>
              <div className="printer-meta">{p.brand} · {p.build_volume}</div>
            </div>
          ))}
        </div>
      )}
      {selectedPrinters.length > 0 && (
        <>
          <div className="card-title" style={{ marginTop: 8 }}><span className="card-title-dot" />Allocation</div>
          {selectedPrinters.map((sp) => {
            const p = printerDB[sp.id];
            if (!p) return null;
            return (
              <div key={sp.id} className="alloc-row">
                <span className="alloc-name">{p.name}</span>
                <div style={{ flex: 1 }}>
                  <input type="range" min={selectedPrinters.length > 1 ? 5 : 100} max={selectedPrinters.length > 1 ? 95 : 100} step={5} value={sp.pct} onChange={(e) => setPrinterPct(sp.id, +e.target.value)} />
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
        <input type="text" placeholder="Search by brand, type, color…" value={filSearch} onChange={(e) => setFilSearch(e.target.value)} />
      </div>
      {filaments.length === 0 ? (
        <div className="empty-state">
          No active filaments found in database.
          <br /><span style={{ fontSize: 12, color: T.textDim, marginTop: 6, display: "block" }}>Add filaments via the Filament Inventory tab.</span>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {filaments.map((f) => (
            <div key={f.id} className={`filament-card ${selectedFil?.id === f.id ? "selected" : ""}`} onClick={() => setSelectedFil(f)}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span className="filament-color-dot" style={{ background: getFilColor(f.color), border: "1px solid rgba(255,255,255,0.1)" }} />
                <span className="fil-name">{f.color}</span>
                <span className="badge badge-info">{f.type}</span>
              </div>
              <div className="fil-meta">
                {f.brand} · {f.finish}
                {f.true_cost_per_kg != null
                  ? <> · <span style={{ color: T.info }}>true: ₱{(f.true_cost_per_kg / 1000).toFixed(4)}/g</span></>
                  : <> · <span style={{ color: T.textDim }}>₱{(f.price_per_kg / 1000).toFixed(4)}/g</span></>}
                {f.selling_price_per_kg != null && <> · <span style={{ color: T.accent }}>sell: ₱{(f.selling_price_per_kg / 1000).toFixed(4)}/g</span></>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Step4({ grams, setGrams, hours, setHours, selectedFil }) {
  const exactFilamentCost = selectedFil ? (grams / 1000) * Number(selectedFil.price_per_kg || 0) : 0;
  const wholeHrs = Math.floor(hours);
  const mins = Math.round((hours - wholeHrs) * 60);

  const handleHrsChange = (v) => {
    const h = Math.max(0, Number(v) || 0);
    setHours(+(h + mins / 60).toFixed(4));
  };
  const handleMinsChange = (v) => {
    const m = Math.max(0, Math.min(59, Number(v) || 0));
    setHours(+(wholeHrs + m / 60).toFixed(4));
  };

  const totalMin = Math.round(hours * 60);

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
        <label>Filament Usage (grams)</label>
        <div className="input-addon">
          <input type="number" min={1} step={1} value={grams} onChange={(e) => setGrams(Math.max(1, Number(e.target.value) || 1))} style={{ borderRadius: "8px 0 0 8px" }} />
          <span className="input-suffix">g</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: T.textDim, marginTop: 6 }}>
          <span>{(grams / 1000).toFixed(3)} kg</span>
          <span style={{ color: T.textMuted }}>{exactFilamentCost.toFixed(2)} ₱ raw material cost</span>
        </div>
      </div>

      <div className="input-group" style={{ marginTop: 16 }}>
        <label>Print Duration</label>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: T.textDim, marginBottom: 4 }}>Hours</div>
            <div className="input-addon">
              <input type="number" min={0} step={1} value={wholeHrs} onChange={(e) => handleHrsChange(e.target.value)} style={{ borderRadius: "8px 0 0 8px" }} />
              <span className="input-suffix">hrs</span>
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: T.textDim, marginBottom: 4 }}>Minutes</div>
            <div className="input-addon">
              <input type="number" min={0} max={59} step={1} value={mins} onChange={(e) => handleMinsChange(e.target.value)} style={{ borderRadius: "8px 0 0 8px" }} />
              <span className="input-suffix">min</span>
            </div>
          </div>
        </div>
        <div style={{ fontSize: 11, color: T.textDim, marginTop: 6 }}>
          Total: <span style={{ color: T.accent, fontFamily: T.fontMono }}>{totalMin} min</span> &nbsp;·&nbsp; {hours.toFixed(2)} hrs
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
          <div className="stat-val">{wholeHrs}h {mins}m</div>
          <div className="stat-sub">{totalMin} min total</div>
        </div>
      </div>
    </div>
  );
}

// ─── STEP 5 — Clean cost breakdown only, no confusing comparison inputs ───────
function Step5({ costResult, pricingConfig, selectedFil }) {
  if (!costResult)
    return <div className="card"><p style={{ color: T.textMuted, fontSize: 13 }}>Computing costs…</p></div>;

  const items = [
    { label: "Filament", ...costResult.filament },
    { label: "Electricity", ...costResult.electricity },
    { label: "Printer Usage", ...costResult.printer_usage },
  ];

  const maxCharged = Math.max(...items.map((i) => i.charged), 0.01);

  // Filament pricing info for context
  const hasTrueCost = selectedFil?.true_cost_per_kg != null;
  const hasSellingPrice = selectedFil?.selling_price_per_kg != null;

  return (
    <div>
      <div className="card">
        <div className="card-title"><span className="card-title-dot" />Cost Breakdown</div>

        {/* Filament pricing context */}
        {selectedFil && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16, padding: "10px 14px", background: T.bgInput, borderRadius: 8 }}>
            <span className="filament-color-dot" style={{ background: getFilColor(selectedFil.color), border: "1px solid rgba(255,255,255,0.1)", alignSelf: "center" }} />
            <span style={{ fontSize: 12, color: T.text }}>{selectedFil.brand} {selectedFil.type} — {selectedFil.color}</span>
            {hasTrueCost && (
              <span style={{ fontSize: 11, color: T.info, fontFamily: T.fontMono }}>
                true: ₱{selectedFil.true_cost_per_kg}/kg
              </span>
            )}
            {hasSellingPrice && (
              <span style={{ fontSize: 11, color: T.accent, fontFamily: T.fontMono }}>
                selling: ₱{selectedFil.selling_price_per_kg}/kg
              </span>
            )}
            {!hasTrueCost && (
              <span style={{ fontSize: 11, color: T.textDim }}>
                ref: ₱{selectedFil.price_per_kg}/kg (no true cost set)
              </span>
            )}
          </div>
        )}

        {/* Legend */}
        <div className="dual-bar-legend" style={{ marginBottom: 16 }}>
          <div className="dual-bar-legend-item">
            <div className="dual-bar-legend-dot" style={{ background: T.textDim, opacity: 0.5 }} />
            Real cost
          </div>
          <div className="dual-bar-legend-item">
            <div className="dual-bar-legend-dot" style={{ background: T.accent, opacity: 0.75 }} />
            Charged to client
          </div>
        </div>

        {items.map((item) => (
          <div key={item.label} className="cmp-row">
            <div className="cmp-header">
              <span className="cmp-label">{item.label}</span>
              <div className="cmp-vals">
                <span className="cmp-real">₱{item.real.toFixed(2)}</span>
                <span style={{ color: T.textDim }}>→</span>
                <span className="cmp-charged">₱{item.charged.toFixed(2)}</span>
                <span className="cmp-profit">+₱{item.profit.toFixed(2)}</span>
              </div>
            </div>
            <div className="dual-bar">
              <div className="dual-bar-charged" style={{ width: `${(item.charged / maxCharged) * 100}%` }} />
              <div className="dual-bar-real" style={{ width: `${(item.real / maxCharged) * 100}%` }} />
            </div>
          </div>
        ))}

        {/* Totals */}
        <div style={{ marginTop: 16, padding: "12px 14px", background: T.bgInput, borderRadius: 9, border: `1px solid ${T.border}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Total</span>
            <div style={{ display: "flex", gap: 14, fontFamily: T.fontMono, fontSize: 13 }}>
              <span style={{ color: T.textDim }}>₱{costResult.totals.real.toFixed(2)}</span>
              <span style={{ color: T.textDim }}>→</span>
              <span style={{ color: T.text, fontWeight: 600 }}>₱{costResult.totals.charged.toFixed(2)}</span>
              <span style={{ color: T.accent, fontWeight: 600 }}>+₱{costResult.totals.profit.toFixed(2)}</span>
            </div>
          </div>
          <div className="dual-bar" style={{ height: 10 }}>
            <div className="dual-bar-charged" style={{ width: "100%" }} />
            <div className="dual-bar-real" style={{ width: `${costResult.totals.charged > 0 ? (costResult.totals.real / costResult.totals.charged) * 100 : 0}%` }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: T.textDim, marginTop: 4 }}>
            <span>{costResult.totals.margin.toFixed(1)}% margin</span>
            <span>Profit multiplier ×{costResult.totals.real > 0 ? (costResult.totals.charged / costResult.totals.real).toFixed(2) : "—"}</span>
          </div>
        </div>
      </div>

      {/* Per-printer breakdown (if multi-printer) */}
      {costResult.per_printer && costResult.per_printer.length > 1 && (
        <div className="card">
          <div className="card-title"><span className="card-title-dot" />Per-Printer Breakdown</div>
          {costResult.per_printer.map((pp) => (
            <div key={pp.id} style={{ padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 13, color: T.text, fontWeight: 500 }}>{pp.name}</span>
                <span style={{ fontSize: 12, color: T.textMuted, fontFamily: T.fontMono }}>{pp.pct}% · {pp.hours}h · {pp.grams}g</span>
              </div>
              <div style={{ display: "flex", gap: 16, fontSize: 11, color: T.textDim, fontFamily: T.fontMono }}>
                <span>Elec: <span style={{ color: T.text }}>₱{pp.elec.charged.toFixed(2)}</span></span>
                <span>Printer: <span style={{ color: T.text }}>₱{pp.printer.charged.toFixed(2)}</span></span>
              </div>
            </div>
          ))}
        </div>
      )}

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
  const margin = finalPrice > 0 ? (profit / finalPrice) * 100 : 0;
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
          <input type="number" value={finalPrice} min={0} step={0.5} onChange={(e) => setCustomPrice(+e.target.value)} style={{ borderRadius: "0 8px 8px 0" }} />
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
          <input type="text" placeholder="e.g. Maria Santos" value={clientName} onChange={(e) => setClientName(e.target.value)} />
          {!clientName.trim() && <div className="error-msg">Required</div>}
        </div>
        <div className="input-group">
          <label>Deadline</label>
          <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </div>
      </div>
      <div className="input-group">
        <label>Parts / Items</label>
        <input type="text" placeholder="e.g. 3x bracket, 1x base" value={parts} onChange={(e) => setParts(e.target.value)} />
      </div>
      <div className="input-group">
        <label>Notes</label>
        <textarea rows={3} placeholder="Special instructions, color requirements…" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ resize: "none" }} />
      </div>
    </div>
  );
}

function Step8({ jobType, selectedPrinters, printerDB, selectedFil, grams, hours, costResult, customPrice, clientName, deadline, notes, parts }) {
  const finalPrice = customPrice ?? costResult?.totals.charged;
  const checks = [
    { label: "Job Type", val: jobType },
    { label: "Printers", val: selectedPrinters.map((p) => `${printerDB[p.id]?.name ?? p.id} (${p.pct}%)`).join(", ") },
    { label: "Filament", val: selectedFil ? `${selectedFil.brand} ${selectedFil.type} — ${selectedFil.color}` : "—" },
    { label: "Parameters", val: `${grams}g · ${hours.toFixed(2)}h` },
    { label: "Total Cost", val: finalPrice ? `₱${finalPrice.toFixed(2)}` : "—" },
    { label: "Client", val: clientName },
    { label: "Deadline", val: deadline || "None" },
    { label: "Parts", val: parts || "Not specified" },
  ];
  return (
    <div className="card">
      <div className="card-title"><span className="card-title-dot" />Final Confirmation</div>
      {checks.map((c) => (
        <div key={c.label} className="confirm-check">
          <span className="check-icon">✓</span>
          <div><div className="check-label">{c.label}</div><div className="check-val">{c.val}</div></div>
        </div>
      ))}
      <div style={{ marginTop: 16, padding: "10px 14px", background: T.accentGlow, border: `1px solid ${T.accentDim}`, borderRadius: 8, fontSize: 13, color: T.accent }}>
        Ready to finalize. Click "Finalize &amp; Print Receipt" to complete.
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
        <h2>TechCraft Innovator</h2>
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
        <div className="r-row"><span>Printers Used</span><span>{job.printers.map((p) => job.printerDB[p.id]?.name ?? p.id).join(", ")}</span></div>
        <div className="r-row"><span>Filament</span><span>{job.filament?.type} {job.filament?.color}</span></div>
        <hr />
        <div className="r-total"><span>TOTAL</span><span>₱{finalPrice.toFixed(2)}</span></div>
        <div className="r-center">Thank you for your order!</div>
        <div className="r-center" style={{ marginTop: 4 }}>Job ID: {String(job.id).toUpperCase().slice(0, 8)}</div>
      </div>
      <div style={{ display: "flex", justifyContent: "center", gap: 12, marginTop: 24 }}>
        <button className="btn btn-ghost" onClick={() => window.print()}>Print Receipt</button>
        <button className="btn btn-primary" onClick={onNew}>New Job →</button>
      </div>
    </div>
  );
}

// ─── INVENTORY VIEW ───────────────────────────────────────────────────────────
function InventoryView({ filaments, setFilaments, reloadFilaments }) {
  const [showAddFil, setShowAddFil] = useState(false);
  const [editFil, setEditFil] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [dbFilamentTypes, setDbFilamentTypes] = useState([]);
  const [dbFinishTypes, setDbFinishTypes] = useState([]);
  const [form, setForm] = useState({ brand: "", type: "", color: "", finish: "", price_per_kg: 25, true_cost_per_kg: "", selling_price_per_kg: "" });
  const [opError, setOpError] = useState("");
  const [opLoading, setOpLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  useEffect(() => {
    const types = [...new Set(filaments.map((f) => f.type))].filter(Boolean).sort();
    const finishes = [...new Set(filaments.map((f) => f.finish))].filter(Boolean).sort();
    setDbFilamentTypes(types.length > 0 ? types : ["PLA", "PLA+", "Silk", "PETG"]);
    setDbFinishTypes(finishes.length > 0 ? finishes : ["Normal", "Matte", "Glossy", "Silk", "Metallic"]);
  }, [filaments]);

  const openAdd = () => {
    setForm({ brand: "", type: dbFilamentTypes[0] || "PLA", color: "", finish: dbFinishTypes[0] || "Matte", price_per_kg: 25, true_cost_per_kg: "", selling_price_per_kg: "" });
    setEditFil(null); setShowAddFil(true); setOpError("");
  };

  const openEdit = (f) => {
    setForm({ brand: f.brand, type: f.type, color: f.color, finish: f.finish, price_per_kg: f.price_per_kg, true_cost_per_kg: f.true_cost_per_kg ?? "", selling_price_per_kg: f.selling_price_per_kg ?? "" });
    setEditFil(f.id); setShowAddFil(true); setOpError("");
  };

  const openDupe = (f) => {
    setForm({ brand: f.brand, type: f.type, color: f.color + " (Copy)", finish: f.finish, price_per_kg: f.price_per_kg, true_cost_per_kg: f.true_cost_per_kg ?? "", selling_price_per_kg: f.selling_price_per_kg ?? "" });
    setEditFil(null); setShowAddFil(true); setOpError("");
  };

  const saveFilament = async () => {
    if (!form.brand || !form.color) return;
    setOpLoading(true); setOpError("");
    try {
      if (editFil) {
        const { error } = await supabase.from("filaments").update({
          brand: form.brand, type: form.type, color: form.color, finish: form.finish,
          price_per_kg: Number(form.price_per_kg),
          true_cost_per_kg: form.true_cost_per_kg !== "" ? Number(form.true_cost_per_kg) : null,
          selling_price_per_kg: form.selling_price_per_kg !== "" ? Number(form.selling_price_per_kg) : null,
        }).eq("id", editFil);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await supabase.from("filaments").insert({
          brand: form.brand, type: form.type, color: form.color, finish: form.finish,
          price_per_kg: Number(form.price_per_kg),
          true_cost_per_kg: form.true_cost_per_kg !== "" ? Number(form.true_cost_per_kg) : null,
          selling_price_per_kg: form.selling_price_per_kg !== "" ? Number(form.selling_price_per_kg) : null,
          active: true,
        });
        if (error) throw new Error(error.message);
      }
      await reloadFilaments();
      setForm({ brand: "", type: dbFilamentTypes[0] || "PLA", color: "", finish: dbFinishTypes[0] || "Matte", price_per_kg: 25, true_cost_per_kg: "", selling_price_per_kg: "" });
      setEditFil(null); setShowAddFil(false);
    } catch (err) {
      setOpError(err.message);
    } finally {
      setOpLoading(false);
    }
  };

  const confirmAndDelete = (f) => { setConfirmDelete(f); setOpError(""); };

  const executeDelete = async () => {
    if (!confirmDelete) return;
    setDeleteLoading(true);
    const id = confirmDelete.id;
    const name = `${confirmDelete.brand} ${confirmDelete.color}`;
    setConfirmDelete(null);
    try {
      const { error } = await supabase.from("filaments").delete().eq("id", id);
      if (error) {
        setOpError(`Cannot delete "${name}": ${error.message}. Try removing associated job records first.`);
      } else {
        setFilaments((prev) => prev.filter((f) => f.id !== id));
      }
    } catch (err) {
      setOpError(err.message || "Failed to delete filament.");
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div>
      <div className="inv-header">
        <div>
          <div className="page-title">Filament Inventory</div>
          <div className="page-sub">{filaments.filter((f) => f.active).length} active · {filaments.length} total filaments</div>
        </div>
        <button className="btn btn-primary" onClick={openAdd}>+ Add Filament</button>
      </div>

      {opError && (
        <div style={{ marginBottom: 16, padding: "12px 16px", background: "rgba(255,92,92,0.08)", border: "1px solid rgba(255,92,92,0.25)", borderRadius: 10, fontSize: 13, color: T.danger }}>
          {opError}
        </div>
      )}

      <div className="card">
        {filaments.length === 0 ? (
          <div className="empty-state">No filaments in database yet.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Filament</th>
                <th>Type</th>
                <th>Finish</th>
                <th>₱/kg (ref)</th>
                <th>True cost/g</th>
                <th>Selling/g</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filaments.map((f) => (
                <tr key={f.id}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="filament-color-dot" style={{ background: getFilColor(f.color), border: "1px solid rgba(255,255,255,0.15)" }} />
                      <div>
                        <div style={{ color: T.text, fontWeight: 500 }}>{f.color}</div>
                        <div style={{ fontSize: 11, color: T.textDim }}>{f.brand}</div>
                      </div>
                    </div>
                  </td>
                  <td><span className="badge badge-info">{f.type}</span></td>
                  <td><span className="tag">{f.finish}</span></td>
                  <td style={{ fontFamily: T.fontMono }}>₱{f.price_per_kg}</td>
                  <td style={{ fontFamily: T.fontMono, color: T.info }}>
                    {f.true_cost_per_kg != null
                      ? <>₱{(f.true_cost_per_kg / 1000).toFixed(4)}<br /><span style={{ fontSize: 10, color: T.textDim }}>₱{f.true_cost_per_kg}/kg</span></>
                      : <span style={{ color: T.textDim }}>₱{(f.price_per_kg / 1000).toFixed(4)}<br /><span style={{ fontSize: 10 }}>(from ref)</span></span>}
                  </td>
                  <td style={{ fontFamily: T.fontMono, color: T.accent }}>
                    {f.selling_price_per_kg != null
                      ? <>₱{(f.selling_price_per_kg / 1000).toFixed(4)}<br /><span style={{ fontSize: 10, color: T.textDim }}>₱{f.selling_price_per_kg}/kg</span></>
                      : <span style={{ color: T.textDim, fontSize: 11 }}>auto ×multiplier</span>}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => openEdit(f)}>Edit</button>
                      <button className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => openDupe(f)}>Dupe</button>
                      <button className="btn btn-danger" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => confirmAndDelete(f)} disabled={deleteLoading}>✕ Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {confirmDelete && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setConfirmDelete(null)}>
          <div className="confirm-modal">
            <h3>Delete Filament?</h3>
            <p>
              Are you sure you want to delete <strong style={{ color: T.text }}>{confirmDelete.brand} {confirmDelete.color}</strong>?
              <br /><br />
              If this filament is referenced by existing jobs, the deletion will fail.
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn btn-danger" style={{ flex: 1, background: "rgba(255,92,92,0.15)" }} onClick={executeDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {showAddFil && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowAddFil(false)}>
          <div className="modal">
            <h3>{editFil ? "Edit Filament" : "Add Filament"}</h3>
            <div className="input-row">
              <div className="input-group">
                <label>Brand</label>
                <input type="text" value={form.brand} onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))} placeholder="e.g. Bambu Lab" />
              </div>
              <div className="input-group">
                <label>Color Name</label>
                <input type="text" value={form.color} onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))} placeholder="e.g. Jade White" />
              </div>
            </div>
            <div className="input-row">
              <div className="input-group">
                <label>Type</label>
                <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
                  {dbFilamentTypes.map((t) => <option key={t}>{t}</option>)}
                  {form.type && !dbFilamentTypes.includes(form.type) && <option value={form.type}>{form.type}</option>}
                </select>
              </div>
              <div className="input-group">
                <label>Finish</label>
                <select value={form.finish} onChange={(e) => setForm((f) => ({ ...f, finish: e.target.value }))}>
                  {dbFinishTypes.map((t) => <option key={t}>{t}</option>)}
                  {form.finish && !dbFinishTypes.includes(form.finish) && <option value={form.finish}>{form.finish}</option>}
                </select>
              </div>
            </div>
            <div className="input-group">
              <label>Reference Price per kg (₱) <span style={{ color: T.textDim, fontSize: 10 }}>— fallback if true cost not set</span></label>
              <input type="number" value={form.price_per_kg} min={1} onChange={(e) => setForm((f) => ({ ...f, price_per_kg: +e.target.value }))} />
            </div>
            <div className="input-row">
              <div className="input-group">
                <label>True Cost per kg (₱) <span style={{ color: T.info, fontSize: 10 }}>— what you pay</span></label>
                <div className="input-addon">
                  <span className="input-prefix">₱</span>
                  <input type="number" min={0} step={0.01} placeholder="e.g. 800" value={form.true_cost_per_kg} onChange={(e) => setForm((f) => ({ ...f, true_cost_per_kg: e.target.value }))} style={{ borderRadius: "0 8px 8px 0" }} />
                </div>
                {form.true_cost_per_kg !== "" && <div style={{ fontSize: 11, color: T.info, marginTop: 3 }}>₱/g: {(Number(form.true_cost_per_kg) / 1000).toFixed(4)}</div>}
              </div>
              <div className="input-group">
                <label>Selling Price per kg (₱) <span style={{ color: T.accent, fontSize: 10 }}>— charged to client</span></label>
                <div className="input-addon">
                  <span className="input-prefix">₱</span>
                  <input type="number" min={0} step={0.01} placeholder="e.g. 1400" value={form.selling_price_per_kg} onChange={(e) => setForm((f) => ({ ...f, selling_price_per_kg: e.target.value }))} style={{ borderRadius: "0 8px 8px 0" }} />
                </div>
                {form.selling_price_per_kg !== "" && <div style={{ fontSize: 11, color: T.accent, marginTop: 3 }}>₱/g: {(Number(form.selling_price_per_kg) / 1000).toFixed(4)}</div>}
              </div>
            </div>
            {form.true_cost_per_kg !== "" && form.selling_price_per_kg !== "" && Number(form.true_cost_per_kg) > 0 && (
              <div style={{ padding: "8px 12px", background: T.accentGlow, border: `1px solid ${T.accentDim}`, borderRadius: 8, fontSize: 12, marginBottom: 8 }}>
                Margin: <strong style={{ color: T.accent }}>{(((Number(form.selling_price_per_kg) - Number(form.true_cost_per_kg)) / Number(form.selling_price_per_kg)) * 100).toFixed(1)}%</strong>
                &nbsp;· Markup: <strong style={{ color: T.accent }}>×{(Number(form.selling_price_per_kg) / Number(form.true_cost_per_kg)).toFixed(2)}</strong>
              </div>
            )}
            {opError && <div className="error-msg" style={{ marginBottom: 8 }}>Error: {opError}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setShowAddFil(false)} disabled={opLoading}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={saveFilament} disabled={!form.brand || !form.color || opLoading}>{opLoading ? "Saving…" : "Save"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── PARAMETERS VIEW ──────────────────────────────────────────────────────────
function ParametersView({ filaments, printerRows, printerDB, pricingConfig, setPricingConfig, reloadFilaments, reloadPrinters }) {
  const [filEdits, setFilEdits] = useState({});
  const [printerEdits, setPrinterEdits] = useState({});
  const [pricingDraft, setPricingDraft] = useState({ electricity_rate: "", markup_multiplier: "", minimum_price: "", formula: "", true_electricity_cost: "", selling_electricity_cost: "" });
  const [saving, setSaving] = useState({ fil: false, printers: false, pricing: false });
  const [msgs, setMsgs] = useState({ fil: "", printers: "", pricing: "" });

  const setMsg = (key, v) => setMsgs((s) => ({ ...s, [key]: v }));
  const onFilChange = (id, v) => setFilEdits((s) => ({ ...s, [id]: v }));
  const onPrinterChange = (id, key, v) => setPrinterEdits((s) => ({ ...s, [id]: { ...(s[id] || {}), [key]: v } }));
  const onPricingChange = (k, v) => setPricingDraft((s) => ({ ...s, [k]: v }));

  const saveFilaments = async () => {
    setSaving((s) => ({ ...s, fil: true })); setMsg("fil", "");
    try {
      for (const [idRaw, valRaw] of Object.entries(filEdits)) {
        if (valRaw === "" || valRaw == null) continue;
        const num = Number(valRaw);
        if (Number.isNaN(num)) continue;
        const f = filaments.find((x) => String(x.id) === String(idRaw));
        if (f && Number(f.price_per_kg) === num) continue;
        const { error } = await supabase.from("filaments").update({ price_per_kg: num }).eq("id", idRaw);
        if (error) throw new Error(error.message);
      }
      await reloadFilaments(); setFilEdits({}); setMsg("fil", "Saved.");
    } catch (err) { setMsg("fil", err.message || "Failed"); }
    finally { setSaving((s) => ({ ...s, fil: false })); }
  };

  const savePrinters = async () => {
    setSaving((s) => ({ ...s, printers: true })); setMsg("printers", "");
    try {
      for (const [idRaw, ed] of Object.entries(printerEdits)) {
        const p = printerRows.find((r) => String(r.id) === String(idRaw));
        if (!p) continue;
        const payload = {};
        if (ed.base !== undefined && ed.base !== "" && Number(ed.base) !== Number(p.base_rate)) payload.base_rate = Number(ed.base);
        if (ed.eff !== undefined && ed.eff !== "" && Number(ed.eff) !== Number(p.efficiency)) payload.efficiency = Number(ed.eff);
        if (ed.labor !== undefined && ed.labor !== "" && Number(ed.labor) !== Number(p.labor)) payload.labor = Number(ed.labor);
        if (ed.mult !== undefined && ed.mult !== "" && Number(ed.mult) !== Number(p.multiplier)) payload.multiplier = Number(ed.mult);
        if (Object.keys(payload).length === 0) continue;
        const { error } = await supabase.from("printers").update(payload).eq("id", idRaw);
        if (error) throw new Error(error.message);
      }
      await reloadPrinters(); setPrinterEdits({}); setMsg("printers", "Saved.");
    } catch (err) { setMsg("printers", err.message || "Failed"); }
    finally { setSaving((s) => ({ ...s, printers: false })); }
  };

  const savePricing = async () => {
    setSaving((s) => ({ ...s, pricing: true })); setMsg("pricing", "");
    try {
      const payload = {};
      if (pricingDraft.electricity_rate !== "") payload.electricity_rate = Number(pricingDraft.electricity_rate);
      if (pricingDraft.markup_multiplier !== "") payload.markup_multiplier = Number(pricingDraft.markup_multiplier);
      if (pricingDraft.minimum_price !== "") payload.minimum_price = Number(pricingDraft.minimum_price);
      if (pricingDraft.formula !== "") payload.formula = pricingDraft.formula;
      if (pricingDraft.true_electricity_cost !== "") payload.true_electricity_cost = pricingDraft.true_electricity_cost === "null" ? null : Number(pricingDraft.true_electricity_cost);
      if (pricingDraft.selling_electricity_cost !== "") payload.selling_electricity_cost = pricingDraft.selling_electricity_cost === "null" ? null : Number(pricingDraft.selling_electricity_cost);
      if (Object.keys(payload).length === 0) { setMsg("pricing", "No changes."); setSaving((s) => ({ ...s, pricing: false })); return; }
      const { error } = await supabase.from("pricing_settings").update({ ...payload, updated_at: new Date().toISOString() }).eq("id", "default");
      if (error) throw new Error(error.message);
      const { data: psData, error: psErr } = await supabase.from("pricing_settings").select("*").eq("id", "default").single();
      if (!psErr && psData) setPricingConfig({
        electricity_rate: Number(psData.electricity_rate),
        minimum_price: Number(psData.minimum_price),
        markup_multiplier: Number(psData.markup_multiplier),
        formula: psData.formula,
        true_electricity_cost: psData.true_electricity_cost != null ? Number(psData.true_electricity_cost) : null,
        selling_electricity_cost: psData.selling_electricity_cost != null ? Number(psData.selling_electricity_cost) : null,
      });
      setPricingDraft({ electricity_rate: "", markup_multiplier: "", minimum_price: "", formula: "", true_electricity_cost: "", selling_electricity_cost: "" });
      setMsg("pricing", "Saved.");
    } catch (err) { setMsg("pricing", err.message || "Failed"); }
    finally { setSaving((s) => ({ ...s, pricing: false })); }
  };

  const MsgBanner = ({ msg }) => {
    if (!msg) return null;
    const isErr = msg.startsWith("Failed") || msg.startsWith("Cannot") || msg.toLowerCase().includes("error");
    return (
      <div style={{ marginTop: 12, padding: "9px 14px", background: isErr ? "rgba(255,92,92,0.08)" : T.accentGlow, border: `1px solid ${isErr ? "rgba(255,92,92,0.25)" : T.accentDim}`, borderRadius: 8, fontSize: 12, color: isErr ? T.danger : T.accent }}>
        {msg}
      </div>
    );
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Parameters</div>
        <div className="page-sub">Edit filament prices, printer rates, and pricing settings.</div>
      </div>

      <div className="card">
        <div className="card-title"><span className="card-title-dot" />Filament Prices</div>
        {filaments.length === 0 ? (
          <div className="empty-state">No filaments found.</div>
        ) : (
          filaments.map((f) => (
            <div key={f.id} className="params-field-row">
              <div className="params-field-info">
                <div className="params-field-name">
                  <span className="filament-color-dot" style={{ background: getFilColor(f.color), border: "1px solid rgba(255,255,255,0.1)" }} />
                  {f.color}
                  <span className="badge badge-info">{f.type}</span>
                  <span className="tag">{f.finish}</span>
                </div>
                <div className="params-field-sub">
                  {f.brand}
                  {" · "}<span style={{ color: T.textDim }}>ref: ₱{f.price_per_kg}/kg</span>
                  {f.true_cost_per_kg != null && <>{" · "}<span style={{ color: T.info }}>true: ₱{f.true_cost_per_kg}/kg</span></>}
                  {f.selling_price_per_kg != null && <>{" · "}<span style={{ color: T.accent }}>sell: ₱{f.selling_price_per_kg}/kg</span></>}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <label style={{ margin: 0, fontSize: 11, color: T.textDim, whiteSpace: "nowrap" }}>₱/kg</label>
                <input type="number" step="any" style={{ width: 130 }} placeholder={String(f.price_per_kg)} value={filEdits[String(f.id)] ?? ""} onChange={(e) => onFilChange(String(f.id), e.target.value === "" ? "" : e.target.value)} />
              </div>
            </div>
          ))
        )}
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={() => { setFilEdits({}); setMsg("fil", ""); }}>Reset</button>
          <button className="btn btn-primary" onClick={saveFilaments} disabled={saving.fil}>{saving.fil ? "Saving…" : "Save Filament Prices"}</button>
        </div>
        <MsgBanner msg={msgs.fil} />
      </div>

      <div className="card">
        <div className="card-title"><span className="card-title-dot" />Printer Rates</div>
        {printerRows.length === 0 ? (
          <div className="empty-state">No active printers found.</div>
        ) : (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 110px 110px 110px 110px", gap: 8, paddingBottom: 8, borderBottom: `1px solid ${T.border}`, marginBottom: 4 }}>
              <div style={{ fontSize: 11, color: T.textDim, textTransform: "uppercase", letterSpacing: "0.6px" }}>Printer</div>
              {["Base Rate", "Efficiency", "Labor", "Multiplier"].map((h) => (
                <div key={h} style={{ fontSize: 11, color: T.textDim, textTransform: "uppercase", letterSpacing: "0.6px", textAlign: "center" }}>{h}</div>
              ))}
            </div>
            {printerRows.map((p) => {
              const ed = printerEdits[String(p.id)] || {};
              return (
                <div key={p.id} className="params-field-row" style={{ display: "grid", gridTemplateColumns: "1fr 110px 110px 110px 110px", gap: 8, alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 13, color: T.text, fontWeight: 500 }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: T.textDim, fontFamily: T.fontMono }}>{p.brand} · {p.wattage}W</div>
                  </div>
                  <input type="number" step="any" placeholder={String(p.base_rate ?? 0)} value={ed.base ?? ""} onChange={(e) => onPrinterChange(String(p.id), "base", e.target.value === "" ? "" : e.target.value)} />
                  <input type="number" step="any" placeholder={String(p.efficiency ?? 0)} value={ed.eff ?? ""} onChange={(e) => onPrinterChange(String(p.id), "eff", e.target.value === "" ? "" : e.target.value)} />
                  <input type="number" step="any" placeholder={String(p.labor ?? 0)} value={ed.labor ?? ""} onChange={(e) => onPrinterChange(String(p.id), "labor", e.target.value === "" ? "" : e.target.value)} />
                  <input type="number" step="any" placeholder={String(p.multiplier ?? 0)} value={ed.mult ?? ""} onChange={(e) => onPrinterChange(String(p.id), "mult", e.target.value === "" ? "" : e.target.value)} />
                </div>
              );
            })}
          </div>
        )}
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={() => { setPrinterEdits({}); setMsg("printers", ""); }}>Reset</button>
          <button className="btn btn-primary" onClick={savePrinters} disabled={saving.printers}>{saving.printers ? "Saving…" : "Save Printer Rates"}</button>
        </div>
        <MsgBanner msg={msgs.printers} />
      </div>

      <div className="card">
        <div className="card-title"><span className="card-title-dot" />Pricing Settings</div>
        {[
          { label: "Electricity Rate", sub: `Current: ₱${pricingConfig?.electricity_rate ?? "—"}/kWh`, key: "electricity_rate", unit: "₱/kWh", placeholder: String(pricingConfig?.electricity_rate ?? 0) },
          { label: "True Electricity Cost", sub: "Actual cost you pay per kWh", key: "true_electricity_cost", unit: "₱/kWh", placeholder: "e.g. 10.50" },
          { label: "Selling Electricity Cost", sub: "Rate charged to client per kWh", key: "selling_electricity_cost", unit: "₱/kWh", placeholder: "e.g. 18.00" },
          { label: "Markup Multiplier", sub: `Current: ×${pricingConfig?.markup_multiplier ?? "—"}`, key: "markup_multiplier", unit: "×", placeholder: String(pricingConfig?.markup_multiplier ?? 1) },
          { label: "Minimum Price", sub: `Current: ₱${pricingConfig?.minimum_price ?? "—"}`, key: "minimum_price", unit: "₱", placeholder: String(pricingConfig?.minimum_price ?? 0) },
        ].map((field) => (
          <div key={field.key} className="params-field-row">
            <div className="params-field-info">
              <div className="params-field-name">{field.label}</div>
              <div className="params-field-sub">{field.sub}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ margin: 0, fontSize: 11, color: T.textDim }}>{field.unit}</label>
              <input type="number" step="0.01" style={{ width: 130 }} placeholder={field.placeholder} value={pricingDraft[field.key]} onChange={(e) => onPricingChange(field.key, e.target.value === "" ? "" : e.target.value)} />
            </div>
          </div>
        ))}
        <div className="params-field-row" style={{ flexDirection: "column", alignItems: "flex-start", gap: 8 }}>
          <div className="params-field-info">
            <div className="params-field-name">Pricing Formula</div>
            <div className="params-field-sub" style={{ marginTop: 4 }}>Current: <span style={{ fontFamily: T.fontMono, color: T.textMuted }}>{pricingConfig?.formula || "—"}</span></div>
          </div>
          <textarea rows={3} placeholder={pricingConfig?.formula || "formula"} value={pricingDraft.formula} onChange={(e) => onPricingChange("formula", e.target.value)} style={{ resize: "vertical", width: "100%", fontFamily: T.fontMono }} />
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={() => { setPricingDraft({ electricity_rate: "", markup_multiplier: "", minimum_price: "", formula: "", true_electricity_cost: "", selling_electricity_cost: "" }); setMsg("pricing", ""); }}>Reset</button>
          <button className="btn btn-primary" onClick={savePricing} disabled={saving.pricing}>{saving.pricing ? "Saving…" : "Save Pricing"}</button>
        </div>
        <MsgBanner msg={msgs.pricing} />
      </div>
    </div>
  );
}

// ─── PRICING SETTINGS VIEW ────────────────────────────────────────────────────
function PricingSettingsView({ pricingConfig, setPricingConfig }) {
  const [draft, setDraft] = useState(pricingConfig);
  const [testError, setTestError] = useState("");
  const [testPrice, setTestPrice] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

  useEffect(() => { setDraft(pricingConfig); }, [pricingConfig]);

  const update = (key, value) => setDraft((c) => ({ ...c, [key]: value }));

  const testFormula = () => {
    try {
      // FIX: include all variables including aliases so test doesn't throw on any valid formula
      const testVars = {
        grams: 100, hours: 4,
        filament_real: 65, filament_charged: 120,
        electricity_real: 16.8, electricity_charged: 25,
        printer_real: 80, printer_charged: 150,
        real_total: 161.8, default_charged_total: 295,
        markup_multiplier: Number(draft.markup_multiplier || 1),
        minimum_price: Number(draft.minimum_price || 0),
        filament_price_per_gram: 65 / 100,
        filament_selling_per_gram: 120 / 100,
        true_cost_per_kg: 650,
        selling_price_per_kg: 1200,
        elec_kwh: 0.56,
        machine_rate: 80,
        machine_charged: 150,
        filament_cost: 65,
        filament_price: 120,
        electricity_cost: 16.8,
        electricity_price: 25,
        total_cost: 161.8,
      };
      const result = _evaluatePricingFormula(draft.formula, testVars);
      setTestError(""); setTestPrice(Math.max(result, Number(draft.minimum_price || 0)));
    } catch (err) { setTestPrice(null); setTestError(err.message || "Formula error"); }
  };

  const save = async () => {
    setSaving(true); setSaveMsg("");
    const payload = {
      electricity_rate: Number(draft.electricity_rate || 0),
      minimum_price: Number(draft.minimum_price || 0),
      markup_multiplier: Number(draft.markup_multiplier || 1),
      formula: draft.formula,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from("pricing_settings").update(payload).eq("id", "default");
    if (error) { setSaveMsg(`Error: ${error.message}`); } else { setPricingConfig({ ...payload }); setSaveMsg("Saved successfully."); testFormula(); }
    setSaving(false);
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Pricing Formula</div>
        <div className="page-sub">Admin-only pricing controls. Not shown on customer receipts.</div>
      </div>
      <div className="grid2">
        <div className="card">
          <div className="card-title"><span className="card-title-dot" />Editable Formula</div>
          <div className="input-group">
            <label>Formula</label>
            <textarea rows={5} value={draft.formula} onChange={(e) => update("formula", e.target.value)} style={{ fontFamily: T.fontMono, resize: "vertical" }} />
            {testError && <div className="error-msg">{testError}</div>}
          </div>
          <div className="input-row">
            <div className="input-group"><label>Markup Multiplier</label><input type="number" step="0.05" value={draft.markup_multiplier} onChange={(e) => update("markup_multiplier", +e.target.value)} /></div>
            <div className="input-group"><label>Minimum Price</label><input type="number" step="1" value={draft.minimum_price} onChange={(e) => update("minimum_price", +e.target.value)} /></div>
          </div>
          <div className="input-group"><label>Electricity Rate / kWh (₱)</label><input type="number" step="0.01" value={draft.electricity_rate} onChange={(e) => update("electricity_rate", +e.target.value)} /></div>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={testFormula}>Test Formula</button>
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={save} disabled={saving}>{saving ? "Saving…" : "Save Pricing"}</button>
          </div>
          {saveMsg && (
            <div style={{ marginTop: 12, padding: "10px 14px", background: saveMsg.startsWith("Error") ? "rgba(255,92,92,0.08)" : T.accentGlow, border: `1px solid ${saveMsg.startsWith("Error") ? "rgba(255,92,92,0.2)" : T.accentDim}`, borderRadius: 8, fontSize: 13, color: saveMsg.startsWith("Error") ? T.danger : T.accent }}>
              {saveMsg}
            </div>
          )}
          {testPrice !== null && (
            <div style={{ marginTop: 10, padding: "12px 16px", background: T.accentGlow, border: `1px solid ${T.accentDim}`, borderRadius: 9, fontSize: 13, color: T.accent }}>
              Test output: ₱{testPrice.toFixed(2)} using sample 100g / 4h data.
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-title"><span className="card-title-dot" />Allowed Variables</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {[
              "grams", "hours",
              "filament_real", "filament_charged",
              "electricity_real", "electricity_charged",
              "printer_real", "printer_charged",
              "real_total", "default_charged_total",
              "markup_multiplier", "minimum_price",
              "machine_rate", "machine_charged",
              "filament_cost", "filament_price",
              "electricity_cost", "electricity_price",
              "total_cost",
              "filament_price_per_gram", "filament_selling_per_gram",
              "elec_kwh",
            ].map((v) => (
              <span key={v} className="tag" style={{ fontFamily: T.fontMono, padding: "6px 9px" }}>{v}</span>
            ))}
          </div>
          <div style={{ marginTop: 18 }}>
            <div className="card-title"><span className="card-title-dot" />Examples</div>
            <div className="rec-card" style={{ marginBottom: 10 }}><div className="rec-title">Simple markup</div><div className="rec-val" style={{ fontFamily: T.fontMono, wordBreak: "break-word" }}>default_charged_total * markup_multiplier</div></div>
            <div className="rec-card" style={{ marginBottom: 10 }}><div className="rec-title">Cost-plus target</div><div className="rec-val" style={{ fontFamily: T.fontMono, wordBreak: "break-word" }}>real_total * 2.2</div></div>
            <div className="rec-card" style={{ marginBottom: 10 }}><div className="rec-title">Machine-rate based</div><div className="rec-val" style={{ fontFamily: T.fontMono, wordBreak: "break-word" }}>machine_rate + filament_price + electricity_price</div></div>
            <div className="rec-card"><div className="rec-title">Weight and time based</div><div className="rec-val" style={{ fontFamily: T.fontMono, wordBreak: "break-word" }}>(grams * 2.5) + (hours * 35)</div></div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── JOB ORDERS VIEW ──────────────────────────────────────────────────────────
const ORDER_STATUSES = ["Queued", "Printing", "Post-Processing", "Done", "Cancelled"];
const STATUS_COLORS = {
  Queued:            { bg: "rgba(91,156,246,0.12)",  border: "rgba(91,156,246,0.3)",  text: "#5B9CF6" },
  Printing:          { bg: "rgba(245,166,35,0.12)",  border: "rgba(245,166,35,0.3)",  text: "#F5A623" },
  "Post-Processing": { bg: "rgba(155,125,255,0.12)", border: "rgba(155,125,255,0.3)", text: "#9B7DFF" },
  Done:              { bg: "rgba(0,229,160,0.12)",   border: "rgba(0,229,160,0.3)",   text: "#00E5A0" },
  Cancelled:         { bg: "rgba(255,92,92,0.12)",   border: "rgba(255,92,92,0.3)",   text: "#FF5C5C" },
};

function StatusBadge({ status }) {
  const c = STATUS_COLORS[status] || STATUS_COLORS.Queued;
  return (
    <span style={{ padding: "3px 9px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: c.bg, border: `1px solid ${c.border}`, color: c.text, whiteSpace: "nowrap" }}>
      {status}
    </span>
  );
}

function DeadlineBadge({ deadline }) {
  if (!deadline) return <span style={{ color: T.textDim, fontSize: 12 }}>—</span>;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(deadline + "T00:00:00");
  const diff = Math.round((d - today) / 86400000);
  if (diff < 0) return <span style={{ fontSize: 12, color: T.danger, fontWeight: 600 }}>⚠ {deadline} (overdue)</span>;
  if (diff === 0) return <span style={{ fontSize: 12, color: T.warn, fontWeight: 600 }}>⚡ Today</span>;
  if (diff <= 2) return <span style={{ fontSize: 12, color: T.warn }}>{deadline} ({diff}d)</span>;
  return <span style={{ fontSize: 12, color: T.textMuted }}>{deadline} ({diff}d)</span>;
}

// FIX: onAddNew now just redirects to New Job wizard — no separate form modal
function JobOrdersView({ jobOrders, setJobOrders, filaments, printerRows, startJobFromOrder, onAddNew }) {
  const [editOrder, setEditOrder] = useState(null);
  const [filterStatus, setFilterStatus] = useState("All");
  const [sortBy, setSortBy] = useState("deadline");
  const [opLoading, setOpLoading] = useState(false);
  const [opError, setOpError] = useState("");
  const [confirmDel, setConfirmDel] = useState(null);
  const [form, setForm] = useState(null);

  const openEdit = (o) => {
    setForm({
      client_name: o.client_name || "", title: o.title || "", description: o.description || "",
      filament_id: o.filament_id || "", printer_id: o.printer_id || "",
      deadline: o.deadline || "", status: o.status || "Queued",
      priority: o.priority || "Normal",
      estimated_grams: o.estimated_grams ?? "", estimated_hours: o.estimated_hours ?? "",
    });
    setEditOrder(o); setOpError("");
  };

  const reloadOrders = async () => {
    const { data } = await supabase.from("job_orders").select("*").order("deadline", { ascending: true, nullsFirst: false });
    if (data) setJobOrders(data);
  };

  const saveEdit = async () => {
    if (!form.client_name.trim() || !form.title.trim()) { setOpError("Client name and title are required."); return; }
    setOpLoading(true); setOpError("");
    const payload = {
      client_name: form.client_name.trim(), title: form.title.trim(), description: form.description || "",
      filament_id: form.filament_id || null, printer_id: form.printer_id || null,
      deadline: form.deadline || null, status: form.status, priority: form.priority,
      estimated_grams: form.estimated_grams !== "" ? Number(form.estimated_grams) : null,
      estimated_hours: form.estimated_hours !== "" ? Number(form.estimated_hours) : null,
      updated_at: new Date().toISOString(),
    };
    try {
      const { error } = await supabase.from("job_orders").update(payload).eq("id", editOrder.id);
      if (error) throw new Error(error.message);
      await reloadOrders(); setEditOrder(null); setForm(null);
    } catch (err) { setOpError(err.message || "Failed to save."); }
    finally { setOpLoading(false); }
  };

  const updateStatus = async (id, status) => {
    setJobOrders((prev) => prev.map((o) => o.id === id ? { ...o, status } : o));
    await supabase.from("job_orders").update({ status, updated_at: new Date().toISOString() }).eq("id", id);
  };

  const deleteOrder = async () => {
    if (!confirmDel) return;
    const id = confirmDel.id; setConfirmDel(null);
    const { error } = await supabase.from("job_orders").delete().eq("id", id);
    if (!error) setJobOrders((prev) => prev.filter((o) => o.id !== id));
    else setOpError(error.message);
  };

  const PRIORITIES = ["Low", "Normal", "High", "Urgent"];
  const PRIORITY_COLOR = { Low: T.textDim, Normal: T.textMuted, High: T.warn, Urgent: T.danger };

  const filtered = jobOrders
    .filter((o) => filterStatus === "All" || o.status === filterStatus)
    .sort((a, b) => {
      if (sortBy === "deadline") {
        if (!a.deadline && !b.deadline) return 0;
        if (!a.deadline) return 1;
        if (!b.deadline) return -1;
        return new Date(a.deadline) - new Date(b.deadline);
      }
      if (sortBy === "priority") {
        const pi = (p) => ["Urgent", "High", "Normal", "Low"].indexOf(p ?? "Normal");
        return pi(a.priority) - pi(b.priority);
      }
      if (sortBy === "status") return (a.status || "").localeCompare(b.status || "");
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });

  const counts = ORDER_STATUSES.reduce((acc, s) => { acc[s] = jobOrders.filter((o) => o.status === s).length; return acc; }, {});

  return (
    <div>
      <div className="inv-header">
        <div>
          <div className="page-title">Job Orders</div>
          <div className="page-sub">{jobOrders.length} total · {counts.Queued || 0} queued · {counts.Printing || 0} printing</div>
        </div>
        {/* FIX: clicking this goes directly to New Job wizard, no separate modal */}
        <button className="btn btn-primary" onClick={onAddNew}>+ New Job Order</button>
      </div>

      <div style={{ marginBottom: 16, padding: "10px 16px", background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 12, color: T.textMuted }}>
        💡 <strong style={{ color: T.text }}>How it works:</strong> Click <strong style={{ color: T.accent }}>+ New Job Order</strong> to open the New Job wizard — fill in client details, filament and parameters, then save as an order at the end. Click <strong style={{ color: T.accent }}>▶ Start Job</strong> on any queued order to load it for pricing and finalizing.
      </div>

      {opError && (
        <div style={{ marginBottom: 16, padding: "12px 16px", background: "rgba(255,92,92,0.08)", border: "1px solid rgba(255,92,92,0.25)", borderRadius: 10, fontSize: 13, color: T.danger }}>{opError}</div>
      )}

      {/* Status filter pills */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
        {["All", ...ORDER_STATUSES].map((s) => {
          const c = s === "All" ? null : STATUS_COLORS[s];
          const active = filterStatus === s;
          return (
            <button key={s} onClick={() => setFilterStatus(s)} style={{
              padding: "5px 12px", borderRadius: 20, border: `1px solid ${active ? (c?.border ?? T.accent) : T.border}`,
              background: active ? (c?.bg ?? T.accentGlow) : "transparent",
              color: active ? (c?.text ?? T.accent) : T.textMuted,
              fontSize: 12, fontWeight: active ? 600 : 400, cursor: "pointer",
            }}>
              {s}{s !== "All" && counts[s] !== undefined ? ` (${counts[s]})` : s === "All" ? ` (${jobOrders.length})` : ""}
            </button>
          );
        })}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 11, color: T.textDim }}>Sort:</span>
          {["deadline", "priority", "status", "created"].map((s) => (
            <button key={s} onClick={() => setSortBy(s)} style={{
              padding: "4px 10px", borderRadius: 6, border: `1px solid ${sortBy === s ? T.accent : T.border}`,
              background: sortBy === s ? T.accentGlow : "transparent",
              color: sortBy === s ? T.accent : T.textMuted, fontSize: 11, cursor: "pointer",
            }}>{s.charAt(0).toUpperCase() + s.slice(1)}</button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "48px 24px" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
          <div style={{ fontSize: 14, color: T.textMuted }}>{filterStatus === "All" ? "No job orders yet" : `No orders with status "${filterStatus}"`}</div>
          <div style={{ fontSize: 12, color: T.textDim, marginTop: 4 }}>Click "+ New Job Order" to start a job through the New Job wizard</div>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={onAddNew}>+ New Job Order</button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {filtered.map((order) => {
            const fil = filaments.find((f) => f.id === order.filament_id);
            const printer = printerRows.find((p) => p.id === order.printer_id);
            return (
              <div key={order.id} className="card" style={{ padding: "16px 20px", marginBottom: 0, borderLeft: `3px solid ${STATUS_COLORS[order.status]?.text ?? T.border}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                      <span style={{ fontSize: 15, fontWeight: 600, color: T.text }}>{order.title}</span>
                      <StatusBadge status={order.status} />
                      {order.priority && order.priority !== "Normal" && (
                        <span style={{ fontSize: 11, fontWeight: 600, color: PRIORITY_COLOR[order.priority] }}>● {order.priority}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 6 }}>
                      Client: <strong style={{ color: T.text }}>{order.client_name}</strong>
                      {fil && <> · <span className="filament-color-dot" style={{ background: getFilColor(fil.color), display: "inline-block", width: 8, height: 8, borderRadius: "50%", verticalAlign: "middle", margin: "0 3px" }} />{fil.brand} {fil.type} {fil.color}</>}
                      {printer && <> · {printer.name}</>}
                    </div>
                    {order.description && <div style={{ fontSize: 12, color: T.textDim, marginBottom: 6 }}>{order.description}</div>}
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                      <div style={{ fontSize: 12, color: T.textMuted }}>Deadline: <DeadlineBadge deadline={order.deadline} /></div>
                      {order.estimated_grams && <div style={{ fontSize: 12, color: T.textMuted }}>~<span style={{ fontFamily: T.fontMono, color: T.text }}>{order.estimated_grams}g</span></div>}
                      {order.estimated_hours != null && order.estimated_hours !== "" && (
                        <div style={{ fontSize: 12, color: T.textMuted }}>
                          ~<span style={{ fontFamily: T.fontMono, color: T.text }}>{Math.floor(order.estimated_hours)}h {Math.round((order.estimated_hours % 1) * 60)}m</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                    <select value={order.status} onChange={(e) => updateStatus(order.id, e.target.value)}
                      style={{ fontSize: 12, padding: "5px 8px", background: STATUS_COLORS[order.status]?.bg, border: `1px solid ${STATUS_COLORS[order.status]?.border}`, color: STATUS_COLORS[order.status]?.text, borderRadius: 6, cursor: "pointer" }}>
                      {ORDER_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <div style={{ display: "flex", gap: 6 }}>
                      {order.status !== "Done" && order.status !== "Cancelled" && (
                        <button className="btn btn-primary" style={{ padding: "4px 10px", fontSize: 11 }} onClick={async () => {
                          await updateStatus(order.id, "Printing");
                          startJobFromOrder({ ...order, status: "Printing" });
                        }}>▶ Start Job</button>
                      )}
                      <button className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => openEdit(order)}>Edit</button>
                      <button className="btn btn-danger" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => setConfirmDel(order)}>✕</button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Confirm delete */}
      {confirmDel && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setConfirmDel(null)}>
          <div className="confirm-modal">
            <h3>Delete Order?</h3>
            <p>Remove <strong style={{ color: T.text }}>{confirmDel.title}</strong> for {confirmDel.client_name}? This cannot be undone.</p>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setConfirmDel(null)}>Cancel</button>
              <button className="btn btn-danger" style={{ flex: 1, background: "rgba(255,92,92,0.15)" }} onClick={deleteOrder}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit modal — only for editing existing orders, not creating new */}
      {editOrder && form && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && (setEditOrder(null), setForm(null))}>
          <div className="modal" style={{ width: 540, maxHeight: "90vh", overflowY: "auto" }}>
            <h3>Edit Job Order</h3>
            <div className="input-row">
              <div className="input-group">
                <label>Client Name *</label>
                <input type="text" value={form.client_name} onChange={(e) => setForm((f) => ({ ...f, client_name: e.target.value }))} />
              </div>
              <div className="input-group">
                <label>Deadline</label>
                <input type="date" value={form.deadline} onChange={(e) => setForm((f) => ({ ...f, deadline: e.target.value }))} />
              </div>
            </div>
            <div className="input-group">
              <label>Job Title *</label>
              <input type="text" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
            </div>
            <div className="input-group">
              <label>Description / Notes</label>
              <textarea rows={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} style={{ resize: "none" }} />
            </div>
            <div className="input-row">
              <div className="input-group">
                <label>Status</label>
                <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}>
                  {ORDER_STATUSES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </div>
              <div className="input-group">
                <label>Priority</label>
                <select value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}>
                  {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
                </select>
              </div>
            </div>
            <div className="input-row">
              <div className="input-group">
                <label>Filament (optional)</label>
                <select value={form.filament_id} onChange={(e) => setForm((f) => ({ ...f, filament_id: e.target.value }))}>
                  <option value="">— None —</option>
                  {filaments.map((f) => <option key={f.id} value={f.id}>{f.brand} {f.type} {f.color}</option>)}
                </select>
              </div>
              <div className="input-group">
                <label>Printer (optional)</label>
                <select value={form.printer_id} onChange={(e) => setForm((f) => ({ ...f, printer_id: e.target.value }))}>
                  <option value="">— None —</option>
                  {printerRows.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>
            <div className="input-row">
              <div className="input-group">
                <label>Est. Weight (g)</label>
                <div className="input-addon">
                  <input type="number" min={1} step={1} value={form.estimated_grams} onChange={(e) => setForm((f) => ({ ...f, estimated_grams: e.target.value }))} style={{ borderRadius: "8px 0 0 8px" }} />
                  <span className="input-suffix">g</span>
                </div>
              </div>
              <div className="input-group">
                <label>Est. Time (hours)</label>
                <div className="input-addon">
                  <input type="number" min={0} step={0.5} value={form.estimated_hours} onChange={(e) => setForm((f) => ({ ...f, estimated_hours: e.target.value }))} style={{ borderRadius: "8px 0 0 8px" }} />
                  <span className="input-suffix">hrs</span>
                </div>
              </div>
            </div>
            {opError && <div className="error-msg" style={{ marginBottom: 8 }}>{opError}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => { setEditOrder(null); setForm(null); }} disabled={opLoading}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={saveEdit} disabled={!form.client_name.trim() || !form.title.trim() || opLoading}>{opLoading ? "Saving…" : "Update Order"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function JobsView({ jobs }) {
  if (jobs.length === 0)
    return (
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
      <div className="page-header"><div className="page-title">Job History</div><div className="page-sub">{jobs.length} jobs this session</div></div>
      <div className="grid2" style={{ marginBottom: 20 }}>
        <div className="stat-card"><div className="stat-label">Total Revenue</div><div className="stat-val">₱{total.toFixed(2)}</div></div>
        <div className="stat-card"><div className="stat-label">Total Profit</div><div className="stat-val stat-profit">₱{totalProfit.toFixed(2)}</div></div>
      </div>
      <div className="card">
        <table className="table">
          <thead><tr><th>ID</th><th>Date</th><th>Client</th><th>Type</th><th>Params</th><th>Revenue</th><th>Profit</th></tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td style={{ fontFamily: T.fontMono, fontSize: 11 }}>{String(j.id).slice(0, 8).toUpperCase()}</td>
                <td>{j.date}</td>
                <td style={{ fontWeight: 500, color: T.text }}>{j.clientName}</td>
                <td><span className="tag">{j.jobType}</span></td>
                <td style={{ fontFamily: T.fontMono, fontSize: 11 }}>{j.grams}g · {j.hours.toFixed(2)}h</td>
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

function AnalyticsView({ jobs }) {
  if (jobs.length === 0)
    return (
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
  const avgMargin = jobs.reduce((s, j) => s + (j.cost?.totals.margin ?? 0), 0) / jobs.length;
  const byType = {};
  jobs.forEach((j) => { byType[j.jobType] = (byType[j.jobType] || 0) + 1; });
  const maxTypeCount = Math.max(...Object.values(byType));
  const filamentProfit = jobs.reduce((s, j) => s + (j.cost?.filament.profit ?? 0), 0);
  const elecProfit = jobs.reduce((s, j) => s + (j.cost?.electricity.profit ?? 0), 0);
  const printerProfit = jobs.reduce((s, j) => s + (j.cost?.printer_usage.profit ?? 0), 0);
  const maxProfit2 = Math.max(filamentProfit, elecProfit, printerProfit, 0.01);
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
              <div className="profit-bar-track"><div className="profit-bar-fill" style={{ width: `${(val / maxProfit2) * 100}%`, background: T.accent }} /></div>
              <span className="profit-bar-val">₱{val.toFixed(2)}</span>
            </div>
          ))}
        </div>
        <div className="card">
          <div className="card-title"><span className="card-title-dot" />Jobs by Type</div>
          {Object.entries(byType).map(([t, c]) => (
            <div key={t} className="profit-bar-wrap">
              <span className="profit-bar-label" style={{ fontSize: 11 }}>{t}</span>
              <div className="profit-bar-track"><div className="profit-bar-fill" style={{ width: `${(c / maxTypeCount) * 100}%`, background: T.purple }} /></div>
              <span className="profit-bar-val" style={{ color: T.purple }}>{c}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
