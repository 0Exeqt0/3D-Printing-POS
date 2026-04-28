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
  labor_rate: 0.20,
  printer_fee_rate: 0.10,
  markup_rate: 0.30,
  job_type_multipliers: {
    "Standard Print": 1.00,
    "Prototype": 1.25,
    "Production Run": 0.90,
    "Multicolor": 1.35,
    "Functional Part": 1.30,
    "Display Model": 1.20,
  },
};

// ─── DB → Internal (UPDATED: includes new rate fields) ────────────────────────
function dbPrinterToInternal(row) {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    model: row.model,
    wattage: Number(row.wattage),
    multicolor: row.multicolor,
    buildVol: row.build_volume,
    cost_per_gram: Number(row.cost_per_gram ?? 0.65),
    cost_per_hour: Number(row.cost_per_hour ?? 8),
    failure_rate: Number(row.failure_rate ?? 0.05),
    _p: {
      base: Number(row.base_rate),
      eff: Number(row.efficiency),
      labor: Number(row.labor),
      mult: Number(row.multiplier),
    },
  };
}

// ─── NEW COMPUTATION ENGINE ────────────────────────────────────────────────────
function _computeEngine(job, PRINTER_DB) {
  const {
    printers, filament, grams, hours,
    pricingConfig = DEFAULT_PRICING_CONFIG,
    jobType = "Standard Print",
  } = job;
  if (!filament || !grams || !hours || !printers?.length) return null;

  const laborRate      = Number(pricingConfig.labor_rate       ?? 0.20);
  const printerFeeRate = Number(pricingConfig.printer_fee_rate ?? 0.10);
  const markupRate     = Number(pricingConfig.markup_rate      ?? 0.30);
  const minimumCharge  = Number(pricingConfig.minimum_price    ?? 100);
  const jobTypeMultipliers = pricingConfig.job_type_multipliers ?? DEFAULT_PRICING_CONFIG.job_type_multipliers;
  const jobTypeMultiplier  = Number(jobTypeMultipliers[jobType] ?? 1.00);

  const perPrinterBreakdown = [];
  let totalRiskAdjustedCost = 0;

  for (const alloc of printers) {
    const p = PRINTER_DB[alloc.id];
    if (!p) continue;
    const pct    = alloc.pct / 100;
    const pGrams = grams * pct;
    const pHours = hours * pct;

    const baseCost        = (p.cost_per_gram * pGrams) + (p.cost_per_hour * pHours);
    const riskAdjustedCost = baseCost * (1 + p.failure_rate);
    totalRiskAdjustedCost += riskAdjustedCost;

    perPrinterBreakdown.push({
      id: p.id,
      name: p.name,
      pct: alloc.pct,
      hours: +pHours.toFixed(2),
      grams: +pGrams.toFixed(1),
      costPerGram: p.cost_per_gram,
      costPerHour: p.cost_per_hour,
      failureRate: p.failure_rate,
      baseCost: +baseCost.toFixed(2),
      riskAdjustedCost: +riskAdjustedCost.toFixed(2),
      isExpensive: false,
    });
  }

  // Flag most expensive printer
  if (perPrinterBreakdown.length > 1) {
    const maxCost = Math.max(...perPrinterBreakdown.map(p => p.riskAdjustedCost));
    perPrinterBreakdown.forEach(p => { p.isExpensive = p.riskAdjustedCost === maxCost; });
  }

  const totalBaseCost      = totalRiskAdjustedCost;
  const overheadMultiplier = 1 + laborRate + printerFeeRate + markupRate;
  const priceBeforeJobType = totalBaseCost * overheadMultiplier;
  const rawFinalPrice      = priceBeforeJobType * jobTypeMultiplier;
  const finalPrice         = Math.max(rawFinalPrice, minimumCharge);
  const isMinimumEnforced  = finalPrice > rawFinalPrice;

  const warnings = [];
  for (const pp of perPrinterBreakdown) {
    if (pp.failureRate > 0.15)
      warnings.push(`${pp.name}: failure rate ${(pp.failureRate * 100).toFixed(0)}% is high — consider recalibration.`);
  }
  const safeMargin = totalBaseCost > 0 ? (finalPrice - totalBaseCost) / finalPrice : 0;
  if (safeMargin < 0.20 && finalPrice > 0)
    warnings.push(`Low margin: ${(safeMargin * 100).toFixed(1)}% — recommend at least 20% to cover overhead.`);

  const profit = finalPrice - totalBaseCost;
  const margin = finalPrice > 0 ? (profit / finalPrice) * 100 : 0;

  return {
    per_printer: perPrinterBreakdown,
    totalBaseCost:      +totalBaseCost.toFixed(2),
    priceBeforeJobType: +priceBeforeJobType.toFixed(2),
    jobTypeMultiplier,
    jobType,
    laborRate,
    printerFeeRate,
    markupRate,
    isMinimumEnforced,
    warnings,
    totals: {
      real:     +totalBaseCost.toFixed(2),
      charged:  +finalPrice.toFixed(2),
      profit:   +profit.toFixed(2),
      margin:   +margin.toFixed(1),
    },
    formula_error: "",
    recommendation: { lowest_cost: "—", fastest: "—", highest_profit: "—" },
    _grams: grams,
    _hours: hours,
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
  { id: 1, label: "Job Type" }, { id: 2, label: "Printers" },
  { id: 3, label: "Filament" }, { id: 4, label: "Parameters" },
  { id: 5, label: "Cost Engine" }, { id: 6, label: "Pricing" },
  { id: 7, label: "Metadata" }, { id: 8, label: "Confirm" },
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
.badge-danger { background: rgba(255,92,92,0.15); color: ${T.danger}; }
label { font-size: 12px; color: ${T.textMuted}; display: block; margin-bottom: 6px; letter-spacing: 0.3px; }
input[type=text], input[type=number], input[type=date], select, textarea {
  width: 100%; padding: 9px 12px; background: ${T.bgInput}; border: 1px solid ${T.border};
  border-radius: 8px; color: ${T.text}; font-size: 13px; font-family: ${T.fontSans};
  outline: none; transition: border 0.15s;
}
input:focus, select:focus, textarea:focus { border-color: ${T.accent}; }
input[type=range] { -webkit-appearance: none; width: 100%; height: 4px; background: ${T.border}; border-radius: 2px; border: none; padding: 0; }
input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%; background: ${T.accent}; cursor: pointer; }
input[type=checkbox] { width: 16px; height: 16px; cursor: pointer; accent-color: ${T.accent}; }
.input-group { margin-bottom: 14px; }
.input-row { display: flex; gap: 12px; margin-bottom: 14px; }
.input-row .input-group { flex: 1; margin-bottom: 0; }
.input-addon { display: flex; align-items: center; }
.input-suffix { padding: 9px 10px; background: ${T.bgInput}; border: 1px solid ${T.border}; border-left: none; border-radius: 0 8px 8px 0; font-size: 12px; color: ${T.textMuted}; white-space: nowrap; }
.input-prefix { padding: 9px 10px; background: ${T.bgInput}; border: 1px solid ${T.border}; border-right: none; border-radius: 8px 0 0 8px; font-size: 12px; color: ${T.textMuted}; }
.input-addon input { border-radius: 0; }
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
.modal { background: ${T.bgCard}; border: 1px solid ${T.border}; border-radius: 16px; padding: 28px; width: 560px; max-width: 90vw; max-height: 90vh; overflow-y: auto; }
.modal h3 { font-size: 16px; font-weight: 600; margin-bottom: 20px; }
.page-header { margin-bottom: 28px; }
.page-title { font-size: 24px; font-weight: 600; color: ${T.text}; }
.page-sub { font-size: 13px; color: ${T.textMuted}; margin-top: 4px; }
.error-msg { font-size: 12px; color: ${T.danger}; margin-top: 5px; }
.validation-gate { padding: 10px 14px; background: rgba(255,92,92,0.08); border: 1px solid rgba(255,92,92,0.2); border-radius: 8px; font-size: 12px; color: ${T.danger}; margin-top: 12px; }
.warn-gate { padding: 10px 14px; background: rgba(245,166,35,0.08); border: 1px solid rgba(245,166,35,0.25); border-radius: 8px; font-size: 12px; color: ${T.warn}; margin-top: 8px; }
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
select option { background: ${T.bgCard}; }
.loading-screen { display: flex; align-items: center; justify-content: center; height: 100vh; flex-direction: column; gap: 14px; }
.loading-spinner { width: 32px; height: 32px; border: 2px solid ${T.border}; border-top-color: ${T.accent}; border-radius: 50%; animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.db-error { padding: 20px 24px; background: rgba(255,92,92,0.08); border: 1px solid rgba(255,92,92,0.2); border-radius: 10px; font-size: 13px; color: ${T.danger}; margin-bottom: 16px; }
.empty-state { text-align: center; padding: 40px 24px; color: ${T.textDim}; font-size: 13px; }
.printer-breakdown-card { background: ${T.bgInput}; border: 1.5px solid ${T.border}; border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; transition: border-color 0.15s; }
.printer-breakdown-card.expensive { border-color: rgba(245,166,35,0.5); }
.engine-formula-box { background: rgba(0,229,160,0.05); border: 1px solid rgba(0,229,160,0.2); border-radius: 10px; padding: 14px 16px; margin-bottom: 16px; }
.formula-row { display: flex; justify-content: space-between; align-items: center; padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 12px; }
.formula-row:last-child { border-bottom: none; }
.formula-label { color: ${T.textMuted}; }
.formula-val { color: ${T.text}; font-family: ${T.fontMono}; font-weight: 500; }
.formula-val.accent { color: ${T.accent}; }
.formula-val.warn { color: ${T.warn}; }
.formula-val.info { color: ${T.info}; }
.section-hint { font-size: 11px; color: ${T.textDim}; padding: 8px 12px; background: rgba(255,255,255,0.02); border-radius: 7px; border: 1px solid ${T.border}; margin-bottom: 16px; line-height: 1.5; }
.confirm-modal { background: ${T.bgCard}; border: 1px solid rgba(255,92,92,0.3); border-radius: 16px; padding: 28px; width: 400px; max-width: 90vw; }
.confirm-modal h3 { font-size: 16px; font-weight: 600; color: ${T.text}; margin-bottom: 10px; }
.confirm-modal p { font-size: 13px; color: ${T.textMuted}; margin-bottom: 20px; line-height: 1.5; }
.printer-rate-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid ${T.border}; }
.printer-rate-item { text-align: center; }
.printer-rate-label { font-size: 10px; color: ${T.textDim}; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 3px; }
.printer-rate-val { font-size: 13px; font-weight: 600; color: ${T.text}; font-family: ${T.fontMono}; }

@media (max-width: 860px) {
  body, #root { min-height: 100dvh; }
  .app { display: block; height: auto; min-height: 100dvh; overflow: visible; padding-bottom: 76px; }
  .sidebar { position: fixed; left: 0; right: 0; bottom: 0; top: auto; z-index: 80; width: 100%; min-width: 0; height: 68px; border-right: none; border-top: 1px solid ${T.border}; flex-direction: row; box-shadow: 0 -12px 30px rgba(0,0,0,0.28); }
  .logo, .nav-label, .nav-bottom { display: none; }
  .nav-section { width: 100%; display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px; padding: 8px; }
  .nav-item { justify-content: center; text-align: center; font-size: 9px; line-height: 1.1; padding: 6px 2px; margin: 0; border-radius: 10px; min-height: 48px; }
  .nav-dot { display: none; }
  .main { padding: 16px; overflow: visible; }
  .page-title { font-size: 22px; }
  .page-header { margin-bottom: 18px; }
  .stepper { overflow-x: auto; padding-bottom: 8px; margin-bottom: 18px; scrollbar-width: none; }
  .stepper::-webkit-scrollbar { display: none; }
  .card { padding: 16px; border-radius: 18px; margin-bottom: 14px; }
  .grid2, .grid3, .grid4 { grid-template-columns: 1fr !important; }
  .input-row { flex-direction: column; gap: 0; }
  .btn-row { position: sticky; bottom: 78px; z-index: 20; background: linear-gradient(180deg, rgba(13,15,20,0), ${T.bg} 22%); padding-top: 18px; gap: 10px; }
  .btn-row .btn { min-height: 44px; }
  .modal-overlay { align-items: flex-end; }
  .modal, .confirm-modal { width: 100%; max-width: none; border-radius: 20px 20px 0 0; padding: 22px; }
  .receipt { max-width: 100%; }
  .table { min-width: 820px; }
  .card:has(.table) { overflow-x: auto; }
  .printer-rate-grid { grid-template-columns: repeat(2, 1fr); }
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
  const [pricingConfig, setPricingConfig] = useState(null);
  const [completedJobs, setCompletedJobs] = useState([]);
  const [dbJobs, setDbJobs] = useState([]);
  const [dbLoading, setDbLoading] = useState(true);
  const [dbError, setDbError] = useState("");

  useEffect(() => {
    async function loadAll() {
      setDbLoading(true); setDbError("");
      try {
        const [
          { data: filData, error: filErr },
          { data: prData, error: prErr },
          { data: psData, error: psErr },
          { data: jobsData, error: jobsErr },
        ] = await Promise.all([
          supabase.from("filaments").select("*").eq("active", true).order("brand"),
          supabase.from("printers").select("*").eq("active", true).order("name"),
          supabase.from("pricing_settings").select("*").eq("id", "default").single(),
          supabase.from("jobs").select("*, filaments(brand,type,color,finish), job_printer_allocations(printer_id,percentage,printers(name))").order("created_at", { ascending: false }).limit(300),
        ]);
        if (filErr) throw new Error(`Filaments: ${filErr.message}`);
        if (prErr) throw new Error(`Printers: ${prErr.message}`);
        if (psErr && psErr.code !== "PGRST116") throw new Error(`Pricing: ${psErr.message}`);
        if (jobsErr) console.warn("Jobs:", jobsErr.message);
        setFilaments(filData || []);
        setPrinterRows(prData || []);
        const dbMap = {};
        for (const row of (prData || [])) dbMap[row.id] = dbPrinterToInternal(row);
        setPrinterDB(dbMap);
        if (jobsData) setDbJobs(jobsData);
        if (psData) {
          setPricingConfig({
            electricity_rate: psData.electricity_rate,
            minimum_price: psData.minimum_price,
            markup_multiplier: psData.markup_multiplier,
            formula: psData.formula,
            labor_rate: psData.labor_rate ?? 0.20,
            printer_fee_rate: psData.printer_fee_rate ?? 0.10,
            markup_rate: psData.markup_rate ?? 0.30,
            job_type_multipliers: psData.job_type_multipliers ?? DEFAULT_PRICING_CONFIG.job_type_multipliers,
          });
        } else {
          setDbError("Pricing settings not found. Please go to Settings and save configuration.");
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

  const reloadAllPrinters = useCallback(async () => {
    const { data, error } = await supabase.from("printers").select("*").order("name");
    if (!error) {
      setPrinterRows(data?.filter(p => p.active) || []);
      const dbMap = {};
      for (const row of (data || [])) if (row.active) dbMap[row.id] = dbPrinterToInternal(row);
      setPrinterDB(dbMap);
      return data || [];
    }
    return [];
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

  // ─── Real-time recalculation on step 5 ──────────────────────────────────────
  useEffect(() => {
    if (step === 5 && selectedFil && grams && hours && selectedPrinters.length > 0 && pricingConfig) {
      const r = _computeEngine(
        { printers: selectedPrinters, filament: selectedFil, grams, hours, pricingConfig, jobType },
        printerDB
      );
      setCostResult(r);
      if (r) setCustomPrice(r.totals.charged);
    }
  }, [step, selectedFil, grams, hours, selectedPrinters, pricingConfig, printerDB, jobType]);

  const goNext = () => { if (stepValid()) setStep((s) => Math.min(8, s + 1)); };
  const goBack = () => { setStep((s) => Math.max(1, s - 1)); if (step <= 5) setCostResult(null); };

  const reloadDbJobs = async () => {
    const { data } = await supabase.from("jobs").select("*, filaments(brand,type,color,finish), job_printer_allocations(printer_id,percentage,printers(name))").order("created_at", { ascending: false }).limit(300);
    if (data) setDbJobs(data);
  };

  const finalizeJob = async () => {
    if (!costResult) return;
    setSaving(true); setSaveError("");
    const finalPrice = customPrice ?? costResult.totals.charged;
    try {
      const { data: jobData, error: jobErr } = await supabase.from("jobs").insert({
        client_name: clientName, job_type: jobType, filament_id: selectedFil.id,
        parts, total_grams: Number(grams), total_hours: Number(hours),
        charged_total: finalPrice, real_total: costResult.totals.real,
        profit_total: costResult.totals.profit, deadline: deadline || null,
        notes: notes || null, cost_result: costResult,
        payment_status: "unpaid", status: "pending",
      }).select().single();
      if (jobErr) throw new Error(jobErr.message);

      if (selectedPrinters.length > 0) {
        const allocRows = selectedPrinters.map((p) => ({ job_id: jobData.id, printer_id: p.id, percentage: p.pct }));
        const { error: allocErr } = await supabase.from("job_printer_allocations").insert(allocRows);
        if (allocErr) console.warn("Printer alloc error:", allocErr.message);
      }

      await reloadDbJobs();
      const job = {
        id: jobData.id, date: new Date().toLocaleDateString(),
        jobType, clientName, deadline, notes, parts, grams, hours,
        filament: selectedFil, printers: selectedPrinters, printerDB,
        cost: costResult, finalPrice,
      };
      setCompletedJobs((prev) => [job, ...prev]);
      setShowReceipt(true);
    } catch (err) {
      setSaveError(err.message || "Failed to save job.");
    } finally {
      setSaving(false);
    }
  };

  const resetJob = () => {
    setStep(1); setJobType(""); setSelectedPrinters([]); setSelectedFil(null);
    setGrams(50); setHours(3); setCostResult(null); setCustomPrice(null);
    setClientName(""); setDeadline(""); setNotes(""); setParts("");
    setShowReceipt(false); setSaveError("");
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
              { id: "jobs", label: "Job Orders" },
              { id: "inventory", label: "Filaments" },
              { id: "printers", label: "Printers" },
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
            <div style={{ fontSize: 11, color: T.textDim, marginTop: 2 }}>{filaments.filter((f) => f.active).length} filaments · {printerRows.length} printers</div>
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
            />
          )}
          {view === "pos" && showReceipt && completedJobs[0] && <ReceiptView job={completedJobs[0]} onNew={resetJob} />}
          {view === "inventory" && <InventoryView filaments={filaments} setFilaments={setFilaments} reloadFilaments={reloadFilaments} />}
          {view === "printers" && <PrinterInventoryView printerRows={printerRows} reloadAllPrinters={reloadAllPrinters} setPrinterRows={setPrinterRows} setPrinterDB={setPrinterDB} />}
          {view === "parameters" && (
            <ParametersView
              filaments={filaments} printerRows={printerRows} printerDB={printerDB}
              pricingConfig={pricingConfig} setPricingConfig={setPricingConfig}
              reloadFilaments={reloadFilaments} reloadPrinters={reloadPrinters}
              grams={grams} hours={hours} selectedFil={selectedFil} selectedPrinters={selectedPrinters}
            />
          )}
          {view === "jobs" && <JobsView dbJobs={dbJobs} reloadDbJobs={reloadDbJobs} />}
          {view === "analytics" && <AnalyticsView dbJobs={dbJobs} />}
          {view === "settings" && <PricingSettingsView pricingConfig={pricingConfig} setPricingConfig={setPricingConfig} />}
        </main>
      </div>
    </>
  );
}

// ─── PRINTER INVENTORY VIEW ───────────────────────────────────────────────────
function PrinterInventoryView({ printerRows, reloadAllPrinters, setPrinterRows, setPrinterDB }) {
  const EMPTY_FORM = {
    name: "", brand: "", model: "", wattage: 200,
    build_volume: "", multicolor: false, active: true,
    base_rate: 5, efficiency: 1.2, labor: 1.0, multiplier: 1.5,
    cost_per_gram: 0.65, cost_per_hour: 8.00, failure_rate: 0.05,
  };

  const [allPrinters, setAllPrinters] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editPrinter, setEditPrinter] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [opError, setOpError] = useState("");
  const [opLoading, setOpLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  useEffect(() => { loadPrinters(); }, []);

  const loadPrinters = async () => {
    const { data, error } = await supabase.from("printers").select("*").order("name");
    if (!error && data) setAllPrinters(data);
  };

  const refreshAll = async () => {
    await loadPrinters();
    const { data } = await supabase.from("printers").select("*").eq("active", true).order("name");
    if (data) {
      setPrinterRows(data);
      const dbMap = {};
      for (const row of data) dbMap[row.id] = dbPrinterToInternal(row);
      setPrinterDB(dbMap);
    }
  };

  const openAdd = () => { setForm(EMPTY_FORM); setEditPrinter(null); setShowForm(true); setOpError(""); };
  const openEdit = (p) => {
    setForm({
      name: p.name, brand: p.brand || "", model: p.model || "",
      wattage: p.wattage, build_volume: p.build_volume || "",
      multicolor: p.multicolor, active: p.active,
      base_rate: p.base_rate, efficiency: p.efficiency, labor: p.labor, multiplier: p.multiplier,
      cost_per_gram: p.cost_per_gram ?? 0.65,
      cost_per_hour: p.cost_per_hour ?? 8.00,
      failure_rate: p.failure_rate ?? 0.05,
    });
    setEditPrinter(p); setShowForm(true); setOpError("");
  };
  const openDupe = (p) => {
    setForm({
      name: p.name + " (Copy)", brand: p.brand || "", model: p.model || "",
      wattage: p.wattage, build_volume: p.build_volume || "",
      multicolor: p.multicolor, active: true,
      base_rate: p.base_rate, efficiency: p.efficiency, labor: p.labor, multiplier: p.multiplier,
      cost_per_gram: p.cost_per_gram ?? 0.65,
      cost_per_hour: p.cost_per_hour ?? 8.00,
      failure_rate: p.failure_rate ?? 0.05,
    });
    setEditPrinter(null); setShowForm(true); setOpError("");
  };

  const savePrinter = async () => {
    if (!form.name.trim()) { setOpError("Printer name is required."); return; }
    if (!form.wattage || Number(form.wattage) <= 0) { setOpError("Wattage must be greater than 0."); return; }
    const fr = Number(form.failure_rate);
    if (fr < 0 || fr > 1) { setOpError("Failure rate must be between 0 and 1 (e.g. 0.05 = 5%)."); return; }
    setOpLoading(true); setOpError("");
    const payload = {
      name: form.name.trim(), brand: form.brand.trim() || null, model: form.model.trim() || null,
      wattage: Number(form.wattage), build_volume: form.build_volume.trim() || null,
      multicolor: !!form.multicolor, active: !!form.active,
      base_rate: Number(form.base_rate) || 0, efficiency: Number(form.efficiency) || 1,
      labor: Number(form.labor) || 1, multiplier: Number(form.multiplier) || 1,
      cost_per_gram: Number(form.cost_per_gram) || 0,
      cost_per_hour: Number(form.cost_per_hour) || 0,
      failure_rate: Number(form.failure_rate) || 0,
      updated_at: new Date().toISOString(),
    };
    try {
      if (editPrinter) {
        const { error } = await supabase.from("printers").update(payload).eq("id", editPrinter.id);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await supabase.from("printers").insert({ ...payload, created_at: new Date().toISOString() });
        if (error) throw new Error(error.message);
      }
      await refreshAll(); setShowForm(false); setEditPrinter(null); setForm(EMPTY_FORM);
    } catch (err) { setOpError(err.message || "Failed to save printer."); }
    finally { setOpLoading(false); }
  };

  const toggleActive = async (p) => {
    const { error } = await supabase.from("printers").update({ active: !p.active, updated_at: new Date().toISOString() }).eq("id", p.id);
    if (!error) await refreshAll();
  };

  const executeDelete = async () => {
    if (!confirmDelete) return;
    setDeleteLoading(true);
    const id = confirmDelete.id;
    setConfirmDelete(null);
    try {
      const { error } = await supabase.from("printers").delete().eq("id", id);
      if (error) setOpError(`Cannot delete "${confirmDelete.name}": ${error.message}.`);
      else await refreshAll();
    } catch (err) { setOpError(err.message || "Failed to delete printer."); }
    finally { setDeleteLoading(false); }
  };

  const displayed = allPrinters.filter(p => showInactive ? true : p.active);
  const activeCount = allPrinters.filter(p => p.active).length;

  return (
    <div>
      <div className="inv-header">
        <div>
          <div className="page-title">Printer Inventory</div>
          <div className="page-sub">{activeCount} active · {allPrinters.length} total printers</div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: T.textMuted, cursor: "pointer", margin: 0 }}>
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} style={{ width: 14, height: 14 }} />
            Show inactive
          </label>
          <button className="btn btn-primary" onClick={openAdd}>+ Add Printer</button>
        </div>
      </div>

      {opError && (
        <div style={{ marginBottom: 16, padding: "12px 16px", background: "rgba(255,92,92,0.08)", border: "1px solid rgba(255,92,92,0.25)", borderRadius: 10, fontSize: 13, color: T.danger }}>
          {opError}
          <button onClick={() => setOpError("")} style={{ marginLeft: 12, background: "none", border: "none", color: T.danger, cursor: "pointer", fontSize: 13 }}>✕</button>
        </div>
      )}

      <div className="section-hint">
        <strong style={{ color: T.text }}>Calculator fields:</strong>{" "}
        <span style={{ color: T.textMuted }}>
          <strong style={{ color: T.info }}>Cost/gram</strong> = material cost charged per gram ·{" "}
          <strong style={{ color: T.info }}>Cost/hr</strong> = machine time rate ·{" "}
          <strong style={{ color: T.warn }}>Failure Rate</strong> = risk buffer (0.05 = 5%) · Applied as: <span style={{ fontFamily: T.fontMono, color: T.accent }}>base_cost × (1 + failure_rate)</span>
        </span>
      </div>

      {displayed.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "48px 24px" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🖨️</div>
          <div style={{ fontSize: 14, color: T.textMuted }}>No printers found</div>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={openAdd}>+ Add Printer</button>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Printer</th>
                <th>Wattage</th>
                <th>Cost/gram</th>
                <th>Cost/hr</th>
                <th>Failure Rate</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayed.map((p) => (
                <tr key={p.id} style={{ opacity: p.active ? 1 : 0.5 }}>
                  <td>
                    <div style={{ fontWeight: 600, color: T.text, fontSize: 14 }}>{p.name}</div>
                    {p.brand && <div style={{ fontSize: 11, color: T.textDim, marginTop: 1 }}>{p.brand}{p.model ? ` · ${p.model}` : ""}</div>}
                    <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                      {p.multicolor && <span className="badge badge-purple">AMS/Multicolor</span>}
                      {p.build_volume && <span className="tag">{p.build_volume}</span>}
                    </div>
                  </td>
                  <td><span className="badge badge-info">{p.wattage}W</span></td>
                  <td style={{ fontFamily: T.fontMono, color: T.info }}>₱{Number(p.cost_per_gram ?? 0).toFixed(4)}/g</td>
                  <td style={{ fontFamily: T.fontMono, color: T.accent }}>₱{Number(p.cost_per_hour ?? 0).toFixed(2)}/hr</td>
                  <td>
                    <span style={{ fontFamily: T.fontMono, color: Number(p.failure_rate ?? 0) > 0.15 ? T.danger : Number(p.failure_rate ?? 0) > 0.08 ? T.warn : T.textMuted }}>
                      {(Number(p.failure_rate ?? 0) * 100).toFixed(1)}%
                    </span>
                  </td>
                  <td>
                    <span style={{
                      padding: "3px 9px", borderRadius: 6, fontSize: 11, fontWeight: 600,
                      background: p.active ? T.accentGlow : "rgba(255,92,92,0.1)",
                      border: `1px solid ${p.active ? T.accentDim : "rgba(255,92,92,0.3)"}`,
                      color: p.active ? T.accent : T.danger,
                    }}>
                      {p.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 5 }}>
                      <button className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => openEdit(p)}>Edit</button>
                      <button className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => openDupe(p)}>Dupe</button>
                      <button className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: 11, color: p.active ? T.warn : T.accent, borderColor: p.active ? "rgba(245,166,35,0.3)" : T.accentDim }} onClick={() => toggleActive(p)}>
                        {p.active ? "Disable" : "Enable"}
                      </button>
                      <button className="btn btn-danger" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => { setConfirmDelete(p); setOpError(""); }} disabled={deleteLoading}>✕</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirmDelete && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setConfirmDelete(null)}>
          <div className="confirm-modal">
            <h3>Delete Printer?</h3>
            <p>Are you sure you want to permanently delete <strong style={{ color: T.text }}>{confirmDelete.name}</strong>? If linked to existing jobs, the deletion will fail. Consider disabling it instead.</p>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn btn-danger" style={{ flex: 1, background: "rgba(255,92,92,0.15)" }} onClick={executeDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowForm(false)}>
          <div className="modal">
            <h3 style={{ marginBottom: 4 }}>{editPrinter ? `Edit: ${editPrinter.name}` : "Add New Printer"}</h3>
            <p style={{ fontSize: 12, color: T.textMuted, marginBottom: 20 }}>Configure printer identity and calculator rates.</p>

            <div style={{ fontSize: 11, fontWeight: 600, color: T.textDim, textTransform: "uppercase", letterSpacing: "1px", marginBottom: 10 }}>Identity</div>
            <div className="input-row">
              <div className="input-group">
                <label>Printer Name *</label>
                <input type="text" placeholder="e.g. Bambu X1 Carbon" value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="input-group">
                <label>Brand</label>
                <input type="text" placeholder="e.g. Bambu Lab" value={form.brand} onChange={(e) => setForm(f => ({ ...f, brand: e.target.value }))} />
              </div>
            </div>
            <div className="input-row">
              <div className="input-group">
                <label>Model</label>
                <input type="text" placeholder="e.g. X1 Carbon Combo" value={form.model} onChange={(e) => setForm(f => ({ ...f, model: e.target.value }))} />
              </div>
              <div className="input-group">
                <label>Build Volume</label>
                <input type="text" placeholder="e.g. 256×256×256mm" value={form.build_volume} onChange={(e) => setForm(f => ({ ...f, build_volume: e.target.value }))} />
              </div>
            </div>
            <div className="input-row">
              <div className="input-group">
                <label>Wattage *</label>
                <div className="input-addon">
                  <input type="number" min={1} step={10} placeholder="200" value={form.wattage} onChange={(e) => setForm(f => ({ ...f, wattage: e.target.value }))} style={{ borderRadius: "8px 0 0 8px" }} />
                  <span className="input-suffix">W</span>
                </div>
              </div>
              <div className="input-group" style={{ display: "flex", flexDirection: "column", justifyContent: "flex-start" }}>
                <label>Features</label>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 9 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", margin: 0, fontSize: 13, color: T.text }}>
                    <input type="checkbox" checked={form.multicolor} onChange={(e) => setForm(f => ({ ...f, multicolor: e.target.checked }))} />
                    Multicolor / AMS
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", margin: 0, fontSize: 13, color: T.text }}>
                    <input type="checkbox" checked={form.active} onChange={(e) => setForm(f => ({ ...f, active: e.target.checked }))} />
                    Active
                  </label>
                </div>
              </div>
            </div>

            <div style={{ fontSize: 11, fontWeight: 600, color: T.textDim, textTransform: "uppercase", letterSpacing: "1px", marginBottom: 10, marginTop: 6 }}>Calculator Rates</div>
            <div style={{ padding: "10px 14px", background: "rgba(91,156,246,0.07)", border: "1px solid rgba(91,156,246,0.18)", borderRadius: 8, fontSize: 11, color: T.info, marginBottom: 14, lineHeight: 1.6 }}>
              <strong>Formula:</strong> <span style={{ fontFamily: T.fontMono }}>base_cost = (cost_per_gram × grams) + (cost_per_hour × hours)</span><br/>
              <span style={{ fontFamily: T.fontMono }}>risk_adjusted = base_cost × (1 + failure_rate)</span>
            </div>
            <div className="input-row">
              <div className="input-group">
                <label>Cost per gram (₱/g) <span style={{ color: T.info, fontSize: 10 }}>— material charge</span></label>
                <div className="input-addon">
                  <span className="input-prefix">₱</span>
                  <input type="number" min={0} step={0.01} placeholder="0.65" value={form.cost_per_gram} onChange={(e) => setForm(f => ({ ...f, cost_per_gram: e.target.value }))} style={{ borderRadius: "0 8px 8px 0" }} />
                </div>
              </div>
              <div className="input-group">
                <label>Cost per hour (₱/hr) <span style={{ color: T.info, fontSize: 10 }}>— machine time</span></label>
                <div className="input-addon">
                  <span className="input-prefix">₱</span>
                  <input type="number" min={0} step={0.5} placeholder="8.00" value={form.cost_per_hour} onChange={(e) => setForm(f => ({ ...f, cost_per_hour: e.target.value }))} style={{ borderRadius: "0 8px 8px 0" }} />
                </div>
              </div>
            </div>
            <div className="input-row">
              <div className="input-group">
                <label>Failure Rate <span style={{ color: T.warn, fontSize: 10 }}>— 0.05 = 5% risk buffer</span></label>
                <div className="input-addon">
                  <input type="number" min={0} max={1} step={0.01} placeholder="0.05" value={form.failure_rate} onChange={(e) => setForm(f => ({ ...f, failure_rate: e.target.value }))} style={{ borderRadius: "8px 0 0 8px" }} />
                  <span className="input-suffix">{form.failure_rate !== "" ? `${(Number(form.failure_rate) * 100).toFixed(0)}%` : "—"}</span>
                </div>
                {Number(form.failure_rate) > 0.15 && (
                  <div style={{ fontSize: 11, color: T.danger, marginTop: 4 }}>⚠ High failure rate — will trigger a warning in the cost engine.</div>
                )}
              </div>
              <div className="input-group">
                <label style={{ marginBottom: 6 }}>Rate preview (per job at 50g/3h)</label>
                <div style={{ padding: "9px 12px", background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12, fontFamily: T.fontMono, color: T.textMuted }}>
                  {form.cost_per_gram && form.cost_per_hour ? (() => {
                    const base = (Number(form.cost_per_gram) * 50) + (Number(form.cost_per_hour) * 3);
                    const risk = base * (1 + Number(form.failure_rate || 0));
                    return <><span style={{ color: T.textDim }}>base: </span><span style={{ color: T.text }}>₱{base.toFixed(2)}</span><span style={{ color: T.textDim }}> → risk-adj: </span><span style={{ color: T.accent }}>₱{risk.toFixed(2)}</span></>;
                  })() : "—"}
                </div>
              </div>
            </div>

            {opError && <div className="error-msg" style={{ marginBottom: 8 }}>Error: {opError}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => { setShowForm(false); setEditPrinter(null); }} disabled={opLoading}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={savePrinter} disabled={!form.name.trim() || opLoading}>
                {opLoading ? "Saving…" : editPrinter ? "Update Printer" : "Add Printer"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── POS VIEW ─────────────────────────────────────────────────────────────────
function POSView({ step, stepValid, goNext, goBack, jobType, setJobType, selectedPrinters, togglePrinter, setPrinterPct, printerDB, printerRows, filaments, filSearch, setFilSearch, selectedFil, setSelectedFil, grams, setGrams, hours, setHours, costResult, customPrice, setCustomPrice, clientName, setClientName, deadline, setDeadline, notes, setNotes, parts, setParts, finalizeJob, saving, saveError, pricingConfig }) {
  return (
    <div>
      <div className="page-header">
        <div className="page-title">New Print Job</div>
        <div className="page-sub">Follow the steps to configure and price your job</div>
      </div>
      <div className="stepper">
        {STEPS.map((s, i) => (
          <div key={s.id} className="step-item">
            <div className={`step-circle ${step > s.id ? "done" : step === s.id ? "active" : ""}`}>{step > s.id ? "✓" : s.id}</div>
            <span className={`step-label ${step === s.id ? "active" : ""}`}>{s.label}</span>
            {i < STEPS.length - 1 && <div className={`step-connector ${step > s.id ? "done" : ""}`} />}
          </div>
        ))}
      </div>
      {step === 1 && <Step1 jobType={jobType} setJobType={setJobType} pricingConfig={pricingConfig} />}
      {step === 2 && <Step2 selectedPrinters={selectedPrinters} togglePrinter={togglePrinter} setPrinterPct={setPrinterPct} printerDB={printerDB} printerRows={printerRows} />}
      {step === 3 && <Step3 filaments={filaments} filSearch={filSearch} setFilSearch={setFilSearch} selectedFil={selectedFil} setSelectedFil={setSelectedFil} />}
      {step === 4 && <Step4 grams={grams} setGrams={setGrams} hours={hours} setHours={setHours} selectedFil={selectedFil} />}
      {step === 5 && <Step5 costResult={costResult} pricingConfig={pricingConfig} selectedFil={selectedFil} jobType={jobType} />}
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

// ─── STEP 1: Job Type (now shows multiplier preview) ─────────────────────────
function Step1({ jobType, setJobType, pricingConfig }) {
  const multipliers = pricingConfig?.job_type_multipliers ?? DEFAULT_PRICING_CONFIG.job_type_multipliers;
  const descriptions = {
    "Standard Print": "Baseline rate",
    "Prototype":      "Higher — iteration cost",
    "Production Run": "Lower — volume efficiency",
    "Multicolor":     "Higher — waste + complexity",
    "Functional Part":"Higher — precision + liability",
    "Display Model":  "Higher — aesthetic premium",
  };
  return (
    <div className="card">
      <div className="card-title"><span className="card-title-dot" />Job Type</div>
      <p style={{ fontSize: 13, color: T.textMuted, marginBottom: 16 }}>Job type sets the price multiplier applied to the base cost.</p>
      <div className="grid3">
        {JOB_TYPES.map((t) => (
          <div key={t} className={`chip ${jobType === t ? "selected" : ""}`} onClick={() => setJobType(t)} style={{ textAlign: "left", padding: "12px 14px" }}>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>{t}</div>
            <div style={{ fontSize: 11, color: jobType === t ? T.accentDim : T.textDim }}>{descriptions[t]}</div>
            <div style={{ fontSize: 12, fontFamily: T.fontMono, color: jobType === t ? T.accent : T.textMuted, marginTop: 4 }}>
              ×{Number(multipliers[t] ?? 1).toFixed(2)}
            </div>
          </div>
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
        <div className="empty-state">No active printers found.<br /><span style={{ fontSize: 12, color: T.textDim, marginTop: 6, display: "block" }}>Add printers via the Printers tab.</span></div>
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
              <div className="printer-meta">{p.brand}{p.model ? ` ${p.model}` : ""}{p.build_volume ? ` · ${p.build_volume}` : ""}</div>
              <div style={{ fontSize: 10, color: T.textDim, marginTop: 4, fontFamily: T.fontMono }}>
                ₱{Number(p.cost_per_gram ?? 0).toFixed(4)}/g · ₱{Number(p.cost_per_hour ?? 0).toFixed(2)}/hr · {(Number(p.failure_rate ?? 0) * 100).toFixed(0)}% fail
              </div>
            </div>
          ))}
        </div>
      )}
      {selectedPrinters.length > 0 && (
        <>
          <div className="card-title" style={{ marginTop: 8 }}><span className="card-title-dot" />Allocation</div>
          {selectedPrinters.map((sp) => {
            const p = printerDB[sp.id]; if (!p) return null;
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
        <div className="empty-state">No active filaments found in database.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {filaments.map((f) => (
            <div key={f.id} className={`filament-card ${selectedFil?.id === f.id ? "selected" : ""}`} onClick={() => setSelectedFil(f)}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span className="filament-color-dot" style={{ background: getFilColor(f.color), border: "1px solid rgba(255,255,255,0.1)" }} />
                <span className="fil-name">{f.color}</span>
                <span className="badge badge-info">{f.type}</span>
              </div>
              <div className="fil-meta">{f.brand} · {f.finish}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Step4({ grams, setGrams, hours, setHours, selectedFil }) {
  const wholeHrs = Math.floor(hours);
  const mins = Math.round((hours - wholeHrs) * 60);
  const handleHrsChange = (v) => { const h = Math.max(0, Number(v) || 0); setHours(+(h + mins / 60).toFixed(4)); };
  const handleMinsChange = (v) => { const m = Math.max(0, Math.min(59, Number(v) || 0)); setHours(+(wholeHrs + m / 60).toFixed(4)); };
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
        <div style={{ fontSize: 11, color: T.textDim, marginTop: 4 }}>{(grams / 1000).toFixed(3)} kg</div>
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
          Total: <span style={{ color: T.accent, fontFamily: T.fontMono }}>{totalMin} min</span> · {hours.toFixed(2)} hrs
        </div>
      </div>
      <div className="grid2" style={{ marginTop: 20 }}>
        <div className="stat-card"><div className="stat-label">Weight</div><div className="stat-val">{grams}g</div></div>
        <div className="stat-card"><div className="stat-label">Time</div><div className="stat-val">{wholeHrs}h {mins}m</div></div>
      </div>
    </div>
  );
}

// ─── STEP 5: NEW COST ENGINE DISPLAY ─────────────────────────────────────────
function Step5({ costResult, pricingConfig, selectedFil, jobType }) {
  if (!costResult) return <div className="card"><p style={{ color: T.textMuted, fontSize: 13 }}>Computing costs…</p></div>;

  const maxRisk = Math.max(...costResult.per_printer.map(p => p.riskAdjustedCost), 0.01);

  return (
    <div>
      {/* Warnings */}
      {costResult.warnings.length > 0 && (
        <div>
          {costResult.warnings.map((w, i) => (
            <div key={i} className="warn-gate">⚠ {w}</div>
          ))}
        </div>
      )}

      {/* Per-printer breakdown */}
      <div className="card">
        <div className="card-title"><span className="card-title-dot" />Per-Printer Cost Breakdown</div>
        <div style={{ fontSize: 11, color: T.textDim, marginBottom: 14 }}>
          For each printer: <span style={{ fontFamily: T.fontMono, color: T.textMuted }}>base_cost = (₱/g × grams) + (₱/hr × hours)</span> · then risk-adjusted by failure rate
        </div>
        {costResult.per_printer.map((pp) => (
          <div key={pp.id} className={`printer-breakdown-card ${pp.isExpensive ? "expensive" : ""}`}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{pp.name}</span>
                {pp.isExpensive && costResult.per_printer.length > 1 && (
                  <span className="badge badge-warn">Most Expensive</span>
                )}
                {pp.failureRate > 0.15 && <span className="badge badge-danger">High Risk</span>}
              </div>
              <span style={{ fontSize: 12, color: T.textMuted, fontFamily: T.fontMono }}>{pp.pct}% · {pp.hours}h · {pp.grams}g</span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 10, color: T.textDim, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 3 }}>Cost/gram</div>
                <div style={{ fontFamily: T.fontMono, fontSize: 13, color: T.info }}>₱{pp.costPerGram.toFixed(4)}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: T.textDim, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 3 }}>Cost/hour</div>
                <div style={{ fontFamily: T.fontMono, fontSize: 13, color: T.info }}>₱{pp.costPerHour.toFixed(2)}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: T.textDim, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 3 }}>Failure Rate</div>
                <div style={{ fontFamily: T.fontMono, fontSize: 13, color: pp.failureRate > 0.15 ? T.danger : pp.failureRate > 0.08 ? T.warn : T.textMuted }}>
                  {(pp.failureRate * 100).toFixed(1)}%
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: T.textDim, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 3 }}>Base Cost</div>
                <div style={{ fontFamily: T.fontMono, fontSize: 13, color: T.textMuted }}>₱{pp.baseCost.toFixed(2)}</div>
              </div>
            </div>

            {/* Bar: base → risk-adjusted */}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ height: 6, background: T.border, borderRadius: 3, overflow: "hidden", marginBottom: 3 }}>
                  <div style={{ height: "100%", borderRadius: 3, background: T.textDim, width: `${(pp.baseCost / maxRisk) * 100}%`, opacity: 0.5, position: "relative" }}>
                    <div style={{ position: "absolute", left: 0, top: 0, height: "100%", borderRadius: 3, background: pp.isExpensive ? T.warn : T.accent, width: `${(pp.riskAdjustedCost / pp.baseCost) * 100}%`, opacity: 0.85 }} />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 12, fontSize: 10, color: T.textDim }}>
                  <span>base ₱{pp.baseCost.toFixed(2)}</span>
                  <span style={{ color: pp.isExpensive ? T.warn : T.accent }}>→ risk-adj ₱{pp.riskAdjustedCost.toFixed(2)}</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Formula trace */}
      <div className="card">
        <div className="card-title"><span className="card-title-dot" />Pricing Formula Trace</div>
        <div className="engine-formula-box">
          <div className="formula-row">
            <span className="formula-label">Total base cost (sum of risk-adjusted)</span>
            <span className="formula-val">₱{costResult.totalBaseCost.toFixed(2)}</span>
          </div>
          <div className="formula-row">
            <span className="formula-label">Labor rate</span>
            <span className="formula-val info">+{(costResult.laborRate * 100).toFixed(0)}%</span>
          </div>
          <div className="formula-row">
            <span className="formula-label">Printer fee rate</span>
            <span className="formula-val info">+{(costResult.printerFeeRate * 100).toFixed(0)}%</span>
          </div>
          <div className="formula-row">
            <span className="formula-label">Markup rate</span>
            <span className="formula-val info">+{(costResult.markupRate * 100).toFixed(0)}%</span>
          </div>
          <div className="formula-row">
            <span className="formula-label">Overhead multiplier</span>
            <span className="formula-val">×{(1 + costResult.laborRate + costResult.printerFeeRate + costResult.markupRate).toFixed(2)}</span>
          </div>
          <div className="formula-row">
            <span className="formula-label">Price before job type</span>
            <span className="formula-val">₱{costResult.priceBeforeJobType.toFixed(2)}</span>
          </div>
          <div className="formula-row">
            <span className="formula-label">Job type ({jobType})</span>
            <span className="formula-val warn">×{costResult.jobTypeMultiplier.toFixed(2)}</span>
          </div>
          <div className="formula-row" style={{ paddingTop: 8, marginTop: 4, borderTop: `1px solid rgba(0,229,160,0.2)` }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Final Price</span>
            <span style={{ fontFamily: T.fontMono, fontSize: 15, fontWeight: 600, color: T.accent }}>
              ₱{costResult.totals.charged.toFixed(2)}
              {costResult.isMinimumEnforced && <span style={{ fontSize: 10, color: T.warn, marginLeft: 8 }}>(min charge enforced)</span>}
            </span>
          </div>
        </div>

        <div className="grid3" style={{ marginTop: 4 }}>
          <div className="stat-card">
            <div className="stat-label">Base Cost</div>
            <div className="stat-val" style={{ fontSize: 16 }}>₱{costResult.totalBaseCost.toFixed(2)}</div>
            <div className="stat-sub">sum of risk-adjusted</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Final Price</div>
            <div className="stat-val stat-profit" style={{ fontSize: 16 }}>₱{costResult.totals.charged.toFixed(2)}</div>
            <div className="stat-sub">{costResult.totals.margin.toFixed(1)}% margin</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Profit</div>
            <div className="stat-val" style={{ fontSize: 16, color: costResult.totals.profit >= 0 ? T.accent : T.danger }}>
              ₱{costResult.totals.profit.toFixed(2)}
            </div>
            <div className="stat-sub">after all costs</div>
          </div>
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
        <div className="stat-card"><div className="stat-label">Suggested Price</div><div className="stat-val">₱{costResult.totals.charged.toFixed(2)}</div><div className="stat-sub">System recommendation</div></div>
        <div className="stat-card"><div className="stat-label">Your Price</div><div className="stat-val stat-profit">₱{finalPrice.toFixed(2)}</div><div className="stat-sub">Editable below</div></div>
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
        <textarea rows={3} placeholder="Special instructions…" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ resize: "none" }} />
      </div>
    </div>
  );
}

function Step8({ jobType, selectedPrinters, printerDB, selectedFil, grams, hours, costResult, customPrice, clientName, deadline, notes, parts }) {
  const finalPrice = customPrice ?? costResult?.totals.charged;
  const checks = [
    { label: "Job Type", val: `${jobType} (×${costResult?.jobTypeMultiplier?.toFixed(2) ?? "—"})` },
    { label: "Printers", val: selectedPrinters.map((p) => `${printerDB[p.id]?.name ?? p.id} (${p.pct}%)`).join(", ") },
    { label: "Filament", val: selectedFil ? `${selectedFil.brand} ${selectedFil.type} — ${selectedFil.color}` : "—" },
    { label: "Parameters", val: `${grams}g · ${hours.toFixed(2)}h` },
    { label: "Base Cost", val: costResult ? `₱${costResult.totalBaseCost.toFixed(2)}` : "—" },
    { label: "Final Price", val: finalPrice ? `₱${finalPrice.toFixed(2)}` : "—" },
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
      await reloadFilaments(); setEditFil(null); setShowAddFil(false);
    } catch (err) { setOpError(err.message); }
    finally { setOpLoading(false); }
  };

  const executeDelete = async () => {
    if (!confirmDelete) return;
    setDeleteLoading(true);
    const id = confirmDelete.id;
    setConfirmDelete(null);
    try {
      const { error } = await supabase.from("filaments").delete().eq("id", id);
      if (error) setOpError(`Cannot delete "${confirmDelete.brand} ${confirmDelete.color}": ${error.message}.`);
      else setFilaments((prev) => prev.filter((f) => f.id !== id));
    } catch (err) { setOpError(err.message || "Failed to delete filament."); }
    finally { setDeleteLoading(false); }
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
      {opError && <div style={{ marginBottom: 16, padding: "12px 16px", background: "rgba(255,92,92,0.08)", border: "1px solid rgba(255,92,92,0.25)", borderRadius: 10, fontSize: 13, color: T.danger }}>{opError}</div>}
      <div className="card">
        {filaments.length === 0 ? <div className="empty-state">No filaments in database yet.</div> : (
          <table className="table">
            <thead><tr><th>Filament</th><th>Type</th><th>Finish</th><th>₱/kg (ref)</th><th>True cost/g</th><th>Selling/g</th><th>Actions</th></tr></thead>
            <tbody>
              {filaments.map((f) => (
                <tr key={f.id}>
                  <td><div style={{ display: "flex", alignItems: "center", gap: 8 }}><span className="filament-color-dot" style={{ background: getFilColor(f.color), border: "1px solid rgba(255,255,255,0.15)" }} /><div><div style={{ color: T.text, fontWeight: 500 }}>{f.color}</div><div style={{ fontSize: 11, color: T.textDim }}>{f.brand}</div></div></div></td>
                  <td><span className="badge badge-info">{f.type}</span></td>
                  <td><span className="tag">{f.finish}</span></td>
                  <td style={{ fontFamily: T.fontMono }}>₱{f.price_per_kg}</td>
                  <td style={{ fontFamily: T.fontMono, color: T.info }}>{f.true_cost_per_kg != null ? `₱${(f.true_cost_per_kg / 1000).toFixed(4)}` : <span style={{ color: T.textDim }}>—</span>}</td>
                  <td style={{ fontFamily: T.fontMono, color: T.accent }}>{f.selling_price_per_kg != null ? `₱${(f.selling_price_per_kg / 1000).toFixed(4)}` : <span style={{ color: T.textDim, fontSize: 11 }}>—</span>}</td>
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => openEdit(f)}>Edit</button>
                      <button className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => openDupe(f)}>Dupe</button>
                      <button className="btn btn-danger" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => setConfirmDelete(f)} disabled={deleteLoading}>✕</button>
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
            <p>Are you sure you want to delete <strong style={{ color: T.text }}>{confirmDelete.brand} {confirmDelete.color}</strong>?</p>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn btn-danger" style={{ flex: 1, background: "rgba(255,92,92,0.15)" }} onClick={executeDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}
      {showAddFil && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowAddFil(false)}>
          <div className="modal" style={{ width: 500 }}>
            <h3>{editFil ? "Edit Filament" : "Add Filament"}</h3>
            <div className="input-row">
              <div className="input-group"><label>Brand</label><input type="text" value={form.brand} onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))} placeholder="e.g. Bambu Lab" /></div>
              <div className="input-group"><label>Color Name</label><input type="text" value={form.color} onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))} placeholder="e.g. Jade White" /></div>
            </div>
            <div className="input-row">
              <div className="input-group"><label>Type</label><select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>{dbFilamentTypes.map((t) => <option key={t}>{t}</option>)}</select></div>
              <div className="input-group"><label>Finish</label><select value={form.finish} onChange={(e) => setForm((f) => ({ ...f, finish: e.target.value }))}>{dbFinishTypes.map((t) => <option key={t}>{t}</option>)}</select></div>
            </div>
            <div className="input-group"><label>Reference Price per kg (₱)</label><input type="number" value={form.price_per_kg} min={1} onChange={(e) => setForm((f) => ({ ...f, price_per_kg: +e.target.value }))} /></div>
            <div className="input-row">
              <div className="input-group"><label>True Cost per kg (₱)</label><div className="input-addon"><span className="input-prefix">₱</span><input type="number" min={0} step={0.01} placeholder="e.g. 800" value={form.true_cost_per_kg} onChange={(e) => setForm((f) => ({ ...f, true_cost_per_kg: e.target.value }))} style={{ borderRadius: "0 8px 8px 0" }} /></div></div>
              <div className="input-group"><label>Selling Price per kg (₱)</label><div className="input-addon"><span className="input-prefix">₱</span><input type="number" min={0} step={0.01} placeholder="e.g. 1400" value={form.selling_price_per_kg} onChange={(e) => setForm((f) => ({ ...f, selling_price_per_kg: e.target.value }))} style={{ borderRadius: "0 8px 8px 0" }} /></div></div>
            </div>
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
  const [saving, setSaving] = useState({ fil: false, printers: false });
  const [msgs, setMsgs] = useState({ fil: "", printers: "" });

  const setMsg = (key, v) => setMsgs((s) => ({ ...s, [key]: v }));
  const onFilChange = (id, v) => setFilEdits((s) => ({ ...s, [id]: v }));
  const onPrinterChange = (id, key, v) => setPrinterEdits((s) => ({ ...s, [id]: { ...(s[id] || {}), [key]: v } }));

  const saveFilaments = async () => {
    setSaving((s) => ({ ...s, fil: true })); setMsg("fil", "");
    try {
      for (const [idRaw, valRaw] of Object.entries(filEdits)) {
        if (valRaw === "" || valRaw == null) continue;
        const num = Number(valRaw); if (Number.isNaN(num)) continue;
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
        const p = printerRows.find((r) => String(r.id) === String(idRaw)); if (!p) continue;
        const payload = {};
        if (ed.cost_per_gram !== undefined && ed.cost_per_gram !== "" && Number(ed.cost_per_gram) !== Number(p.cost_per_gram)) payload.cost_per_gram = Number(ed.cost_per_gram);
        if (ed.cost_per_hour !== undefined && ed.cost_per_hour !== "" && Number(ed.cost_per_hour) !== Number(p.cost_per_hour)) payload.cost_per_hour = Number(ed.cost_per_hour);
        if (ed.failure_rate !== undefined && ed.failure_rate !== "" && Number(ed.failure_rate) !== Number(p.failure_rate)) payload.failure_rate = Number(ed.failure_rate);
        if (Object.keys(payload).length === 0) continue;
        const { error } = await supabase.from("printers").update(payload).eq("id", idRaw);
        if (error) throw new Error(error.message);
      }
      await reloadPrinters(); setPrinterEdits({}); setMsg("printers", "Saved.");
    } catch (err) { setMsg("printers", err.message || "Failed"); }
    finally { setSaving((s) => ({ ...s, printers: false })); }
  };

  const MsgBanner = ({ msg }) => {
    if (!msg) return null;
    const isErr = msg.startsWith("Failed") || msg.toLowerCase().includes("error");
    return <div style={{ marginTop: 12, padding: "9px 14px", background: isErr ? "rgba(255,92,92,0.08)" : T.accentGlow, border: `1px solid ${isErr ? "rgba(255,92,92,0.25)" : T.accentDim}`, borderRadius: 8, fontSize: 12, color: isErr ? T.danger : T.accent }}>{msg}</div>;
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Parameters</div>
        <div className="page-sub">Quick-edit filament prices and printer calculator rates.</div>
      </div>

      <div className="card">
        <div className="card-title"><span className="card-title-dot" />Filament Reference Prices</div>
        {filaments.length === 0 ? <div className="empty-state">No filaments found.</div> : filaments.map((f) => (
          <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, color: T.text, display: "flex", alignItems: "center", gap: 8 }}>
                <span className="filament-color-dot" style={{ background: getFilColor(f.color), border: "1px solid rgba(255,255,255,0.1)" }} />
                {f.color}<span className="badge badge-info">{f.type}</span>
              </div>
              <div style={{ fontSize: 11, color: T.textDim, fontFamily: T.fontMono, marginTop: 2 }}>{f.brand} · ref: ₱{f.price_per_kg}/kg</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ margin: 0, fontSize: 11, color: T.textDim }}>₱/kg</label>
              <input type="number" step="any" style={{ width: 130 }} placeholder={String(f.price_per_kg)} value={filEdits[String(f.id)] ?? ""} onChange={(e) => onFilChange(String(f.id), e.target.value === "" ? "" : e.target.value)} />
            </div>
          </div>
        ))}
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={() => { setFilEdits({}); setMsg("fil", ""); }}>Reset</button>
          <button className="btn btn-primary" onClick={saveFilaments} disabled={saving.fil}>{saving.fil ? "Saving…" : "Save Filament Prices"}</button>
        </div>
        <MsgBanner msg={msgs.fil} />
      </div>

      <div className="card">
        <div className="card-title"><span className="card-title-dot" />Printer Calculator Rates</div>
        <div className="section-hint">Edit per-printer rates used in the cost engine. Changes apply to all future jobs.</div>
        {printerRows.length === 0 ? <div className="empty-state">No active printers found.</div> : (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 130px 130px 130px", gap: 8, paddingBottom: 8, borderBottom: `1px solid ${T.border}`, marginBottom: 4 }}>
              <div style={{ fontSize: 11, color: T.textDim, textTransform: "uppercase", letterSpacing: "0.6px" }}>Printer</div>
              {["Cost/gram (₱)", "Cost/hr (₱)", "Failure Rate"].map((h) => (
                <div key={h} style={{ fontSize: 11, color: T.textDim, textTransform: "uppercase", letterSpacing: "0.6px", textAlign: "center" }}>{h}</div>
              ))}
            </div>
            {printerRows.map((p) => {
              const ed = printerEdits[String(p.id)] || {};
              return (
                <div key={p.id} style={{ display: "grid", gridTemplateColumns: "1fr 130px 130px 130px", gap: 8, alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${T.border}` }}>
                  <div>
                    <div style={{ fontSize: 13, color: T.text, fontWeight: 500 }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: T.textDim, fontFamily: T.fontMono }}>{p.brand || ""} · {p.wattage}W</div>
                  </div>
                  <input type="number" step="0.01" placeholder={String(p.cost_per_gram ?? 0)} value={ed.cost_per_gram ?? ""} onChange={(e) => onPrinterChange(String(p.id), "cost_per_gram", e.target.value === "" ? "" : e.target.value)} />
                  <input type="number" step="0.5" placeholder={String(p.cost_per_hour ?? 0)} value={ed.cost_per_hour ?? ""} onChange={(e) => onPrinterChange(String(p.id), "cost_per_hour", e.target.value === "" ? "" : e.target.value)} />
                  <input type="number" step="0.01" min={0} max={1} placeholder={String(p.failure_rate ?? 0)} value={ed.failure_rate ?? ""} onChange={(e) => onPrinterChange(String(p.id), "failure_rate", e.target.value === "" ? "" : e.target.value)} />
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
    </div>
  );
}

// ─── PRICING SETTINGS VIEW (UPDATED) ─────────────────────────────────────────
function PricingSettingsView({ pricingConfig, setPricingConfig }) {
  const [draft, setDraft] = useState(pricingConfig || DEFAULT_PRICING_CONFIG);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [multiplierEdits, setMultiplierEdits] = useState({});

  useEffect(() => { if (pricingConfig) setDraft(pricingConfig); }, [pricingConfig]);
  const update = (key, value) => setDraft((c) => ({ ...c, [key]: value }));
  const updateMultiplier = (jobType, val) => setMultiplierEdits(e => ({ ...e, [jobType]: val }));

  const save = async () => {
    setSaving(true); setSaveMsg("");

    // Merge multiplier edits
    const mergedMultipliers = { ...(draft.job_type_multipliers ?? DEFAULT_PRICING_CONFIG.job_type_multipliers) };
    for (const [jt, val] of Object.entries(multiplierEdits)) {
      if (val !== "" && !Number.isNaN(Number(val))) mergedMultipliers[jt] = Number(val);
    }

    const payload = {
      electricity_rate:     Number(draft.electricity_rate || 0),
      minimum_price:        Number(draft.minimum_price || 0),
      markup_multiplier:    Number(draft.markup_multiplier || 1),
      formula:              draft.formula,
      labor_rate:           Number(draft.labor_rate || 0),
      printer_fee_rate:     Number(draft.printer_fee_rate || 0),
      markup_rate:          Number(draft.markup_rate || 0),
      job_type_multipliers: mergedMultipliers,
      updated_at:           new Date().toISOString(),
    };

    const { error } = await supabase.from("pricing_settings").update(payload).eq("id", "default");
    if (error) {
      setSaveMsg(`Error: ${error.message}`);
    } else {
      setPricingConfig(payload);
      setMultiplierEdits({});
      setSaveMsg("Saved successfully.");
    }
    setSaving(false);
  };

  const multipliers = draft.job_type_multipliers ?? DEFAULT_PRICING_CONFIG.job_type_multipliers;
  const jobTypeDescriptions = {
    "Standard Print":  "Baseline — no adjustment",
    "Prototype":       "Higher — iteration cost + R&D",
    "Production Run":  "Lower — volume efficiency discount",
    "Multicolor":      "Higher — material waste + setup complexity",
    "Functional Part": "Higher — precision + higher liability",
    "Display Model":   "Higher — aesthetic premium + finishing",
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-title">Pricing Settings</div>
        <div className="page-sub">Global pricing rates and job type multipliers applied to the cost engine.</div>
      </div>

      <div className="grid2">
        <div>
          <div className="card">
            <div className="card-title"><span className="card-title-dot" />Global Overhead Rates</div>
            <div style={{ fontSize: 11, color: T.info, padding: "8px 12px", background: "rgba(91,156,246,0.07)", border: "1px solid rgba(91,156,246,0.18)", borderRadius: 8, marginBottom: 16, lineHeight: 1.7, fontFamily: T.fontMono }}>
              price = total_base_cost × (1 + labor + printer_fee + markup) × job_multiplier
            </div>
            <div className="input-row">
              <div className="input-group">
                <label>Labor Rate <span style={{ color: T.info, fontSize: 10 }}>— e.g. 0.20 = 20%</span></label>
                <div className="input-addon">
                  <input type="number" step="0.01" min={0} max={2} value={draft.labor_rate ?? 0.20} onChange={(e) => update("labor_rate", +e.target.value)} style={{ borderRadius: "8px 0 0 8px" }} />
                  <span className="input-suffix">{((draft.labor_rate ?? 0) * 100).toFixed(0)}%</span>
                </div>
              </div>
              <div className="input-group">
                <label>Printer Fee Rate <span style={{ color: T.info, fontSize: 10 }}>— depreciation overhead</span></label>
                <div className="input-addon">
                  <input type="number" step="0.01" min={0} max={2} value={draft.printer_fee_rate ?? 0.10} onChange={(e) => update("printer_fee_rate", +e.target.value)} style={{ borderRadius: "8px 0 0 8px" }} />
                  <span className="input-suffix">{((draft.printer_fee_rate ?? 0) * 100).toFixed(0)}%</span>
                </div>
              </div>
            </div>
            <div className="input-row">
              <div className="input-group">
                <label>Markup Rate <span style={{ color: T.accent, fontSize: 10 }}>— profit margin</span></label>
                <div className="input-addon">
                  <input type="number" step="0.01" min={0} max={5} value={draft.markup_rate ?? 0.30} onChange={(e) => update("markup_rate", +e.target.value)} style={{ borderRadius: "8px 0 0 8px" }} />
                  <span className="input-suffix">{((draft.markup_rate ?? 0) * 100).toFixed(0)}%</span>
                </div>
              </div>
              <div className="input-group">
                <label>Minimum Charge (₱)</label>
                <div className="input-addon">
                  <span className="input-prefix">₱</span>
                  <input type="number" step="10" min={0} value={draft.minimum_price ?? 100} onChange={(e) => update("minimum_price", +e.target.value)} style={{ borderRadius: "0 8px 8px 0" }} />
                </div>
              </div>
            </div>
            <div className="input-group">
              <label>Electricity Rate (₱/kWh)</label>
              <div className="input-addon">
                <span className="input-prefix">₱</span>
                <input type="number" step="0.01" value={draft.electricity_rate ?? 12} onChange={(e) => update("electricity_rate", +e.target.value)} style={{ borderRadius: "0 8px 8px 0" }} />
              </div>
            </div>

            {/* Live preview */}
            {(() => {
              const base = 100;
              const oh = (1 + Number(draft.labor_rate ?? 0) + Number(draft.printer_fee_rate ?? 0) + Number(draft.markup_rate ?? 0));
              const price = Math.max(base * oh, Number(draft.minimum_price ?? 0));
              return (
                <div style={{ padding: "10px 14px", background: T.accentGlow, border: `1px solid ${T.accentDim}`, borderRadius: 8, fontSize: 12, marginTop: 4 }}>
                  <div style={{ color: T.textMuted, marginBottom: 4 }}>Preview at ₱100 base cost (Standard Print):</div>
                  <div style={{ display: "flex", gap: 16, fontFamily: T.fontMono, flexWrap: "wrap" }}>
                    <span style={{ color: T.textDim }}>×{oh.toFixed(2)} overhead</span>
                    <span style={{ color: T.accent }}>→ ₱{price.toFixed(2)} final</span>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>

        <div>
          <div className="card">
            <div className="card-title"><span className="card-title-dot" />Job Type Multipliers</div>
            <p style={{ fontSize: 12, color: T.textMuted, marginBottom: 16 }}>Applied after overhead. ×1.00 = baseline rate.</p>
            {JOB_TYPES.map((jt) => {
              const current = Number(multipliers[jt] ?? 1);
              const edited = multiplierEdits[jt];
              const displayVal = edited !== undefined ? edited : current;
              return (
                <div key={jt} style={{ padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <div>
                      <div style={{ fontSize: 13, color: T.text, fontWeight: 500 }}>{jt}</div>
                      <div style={{ fontSize: 11, color: T.textDim, marginTop: 1 }}>{jobTypeDescriptions[jt]}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className="input-prefix" style={{ borderRadius: "8px 0 0 8px", padding: "6px 8px", fontSize: 12 }}>×</span>
                      <input type="number" step="0.05" min={0.1} max={5} style={{ width: 80, borderRadius: "0 8px 8px 0", padding: "6px 8px" }}
                        value={displayVal}
                        onChange={(e) => updateMultiplier(jt, e.target.value === "" ? "" : e.target.value)}
                      />
                    </div>
                  </div>
                  {/* Mini bar showing relative multiplier */}
                  <div style={{ height: 3, background: T.border, borderRadius: 2, overflow: "hidden" }}>
                    <div style={{ height: "100%", borderRadius: 2, background: Number(displayVal) >= 1 ? T.accent : T.warn, width: `${Math.min(Number(displayVal || 1) / 2 * 100, 100)}%`, transition: "width 0.3s" }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
        <button className="btn btn-ghost" onClick={() => { setDraft(pricingConfig || DEFAULT_PRICING_CONFIG); setMultiplierEdits({}); setSaveMsg(""); }}>Reset</button>
        <button className="btn btn-primary" style={{ minWidth: 140 }} onClick={save} disabled={saving}>{saving ? "Saving…" : "Save All Settings"}</button>
      </div>
      {saveMsg && (
        <div style={{ marginTop: 12, padding: "10px 14px", background: saveMsg.startsWith("Error") ? "rgba(255,92,92,0.08)" : T.accentGlow, border: `1px solid ${saveMsg.startsWith("Error") ? "rgba(255,92,92,0.2)" : T.accentDim}`, borderRadius: 8, fontSize: 13, color: saveMsg.startsWith("Error") ? T.danger : T.accent }}>
          {saveMsg}
        </div>
      )}
    </div>
  );
}

// ─── JOBS VIEW ────────────────────────────────────────────────────────────────
function JobsView({ dbJobs, reloadDbJobs }) {
  const [payingJob, setPayingJob] = useState(null);
  const [payForm, setPayForm] = useState({ amount: "", method: "cash", reference_number: "" });
  const [payLoading, setPayLoading] = useState(false);
  const [payError, setPayError] = useState("");
  const [updatingStatus, setUpdatingStatus] = useState(null);

  const recordPayment = async () => {
    if (!payingJob || !payForm.amount) return;
    setPayLoading(true); setPayError("");
    try {
      const { error: payErr } = await supabase.from("payments").insert({ job_id: payingJob.id, amount: Number(payForm.amount), method: payForm.method, reference_number: payForm.reference_number || null });
      if (payErr) throw new Error(payErr.message);
      await supabase.from("jobs").update({ payment_status: "paid" }).eq("id", payingJob.id);
      await reloadDbJobs();
      setPayingJob(null); setPayForm({ amount: "", method: "cash", reference_number: "" });
    } catch (err) { setPayError(err.message); }
    finally { setPayLoading(false); }
  };

  const updateJobStatus = async (id, status) => {
    setUpdatingStatus(id);
    await supabase.from("jobs").update({ status }).eq("id", id);
    await reloadDbJobs(); setUpdatingStatus(null);
  };

  if (dbJobs.length === 0)
    return (
      <div>
        <div className="page-header"><div className="page-title">Job Orders</div></div>
        <div className="card" style={{ textAlign: "center", padding: "48px 24px" }}>
          <div style={{ fontSize: 14, color: T.textMuted }}>No jobs in database yet</div>
        </div>
      </div>
    );

  const total = dbJobs.reduce((s, j) => s + Number(j.charged_total || 0), 0);
  const totalProfit = dbJobs.reduce((s, j) => s + Number(j.profit_total || 0), 0);
  const unpaidCount = dbJobs.filter((j) => j.payment_status !== "paid").length;
  const JOB_STATUSES = ["pending", "printing", "done", "cancelled"];
  const PAYMENT_COLORS = {
    paid: { bg: "rgba(0,229,160,0.12)", border: "rgba(0,229,160,0.3)", text: "#00E5A0" },
    unpaid: { bg: "rgba(245,166,35,0.12)", border: "rgba(245,166,35,0.3)", text: "#F5A623" },
  };

  return (
    <div>
      <div className="page-header"><div className="page-title">Job Orders</div><div className="page-sub">{dbJobs.length} total · {unpaidCount} unpaid</div></div>
      <div className="grid4" style={{ marginBottom: 20 }}>
        <div className="stat-card"><div className="stat-label">Total Revenue</div><div className="stat-val">₱{total.toFixed(2)}</div></div>
        <div className="stat-card"><div className="stat-label">Total Profit</div><div className="stat-val stat-profit">₱{totalProfit.toFixed(2)}</div></div>
        <div className="stat-card"><div className="stat-label">Jobs</div><div className="stat-val">{dbJobs.length}</div></div>
        <div className="stat-card"><div className="stat-label">Unpaid</div><div className="stat-val" style={{ color: unpaidCount > 0 ? T.warn : T.accent }}>{unpaidCount}</div></div>
      </div>
      <div className="card">
        <table className="table">
          <thead><tr><th>ID</th><th>Date</th><th>Client</th><th>Type</th><th>Params</th><th>Revenue</th><th>Profit</th><th>Status</th><th>Payment</th><th>Actions</th></tr></thead>
          <tbody>
            {dbJobs.map((j) => {
              const pc = PAYMENT_COLORS[j.payment_status] ?? PAYMENT_COLORS.unpaid;
              return (
                <tr key={j.id}>
                  <td style={{ fontFamily: T.fontMono, fontSize: 11 }}>{String(j.id).slice(0, 8).toUpperCase()}</td>
                  <td style={{ fontSize: 11, whiteSpace: "nowrap" }}>{j.created_at ? new Date(j.created_at).toLocaleDateString() : "—"}</td>
                  <td style={{ fontWeight: 500, color: T.text }}>{j.client_name}</td>
                  <td><span className="tag">{j.job_type}</span></td>
                  <td style={{ fontFamily: T.fontMono, fontSize: 11 }}>{j.total_grams}g · {Number(j.total_hours).toFixed(2)}h</td>
                  <td style={{ fontFamily: T.fontMono, color: T.text, fontWeight: 600 }}>₱{Number(j.charged_total).toFixed(2)}</td>
                  <td style={{ fontFamily: T.fontMono, color: T.accent }}>+₱{Number(j.profit_total).toFixed(2)}</td>
                  <td>
                    <select value={j.status} onChange={(e) => updateJobStatus(j.id, e.target.value)} disabled={updatingStatus === j.id} style={{ fontSize: 11, padding: "3px 6px", background: T.bgInput, border: `1px solid ${T.border}`, color: T.textMuted, borderRadius: 5 }}>
                      {JOB_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  <td><span style={{ padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 600, background: pc.bg, border: `1px solid ${pc.border}`, color: pc.text }}>{j.payment_status || "unpaid"}</span></td>
                  <td>
                    {j.payment_status !== "paid" && (
                      <button className="btn btn-ghost" style={{ padding: "3px 9px", fontSize: 11 }} onClick={() => { setPayingJob(j); setPayForm({ amount: String(j.charged_total), method: "cash", reference_number: "" }); setPayError(""); }}>Pay</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {payingJob && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setPayingJob(null)}>
          <div className="modal" style={{ width: 420 }}>
            <h3>Record Payment</h3>
            <div style={{ marginBottom: 16, padding: "10px 14px", background: T.bgInput, borderRadius: 8, fontSize: 13 }}>
              <strong style={{ color: T.text }}>{payingJob.client_name}</strong><span style={{ color: T.textMuted }}> · {payingJob.job_type}</span>
              <div style={{ color: T.accent, fontFamily: T.fontMono, marginTop: 4, fontSize: 15, fontWeight: 600 }}>₱{Number(payingJob.charged_total).toFixed(2)}</div>
            </div>
            <div className="input-group"><label>Amount (₱)</label><input type="number" min={0} step={0.01} value={payForm.amount} onChange={(e) => setPayForm((f) => ({ ...f, amount: e.target.value }))} /></div>
            <div className="input-group"><label>Payment Method</label><select value={payForm.method} onChange={(e) => setPayForm((f) => ({ ...f, method: e.target.value }))}>{["cash", "gcash", "maya", "bank_transfer", "card", "other"].map((m) => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1).replace("_", " ")}</option>)}</select></div>
            <div className="input-group"><label>Reference Number (optional)</label><input type="text" placeholder="e.g. GCash ref #" value={payForm.reference_number} onChange={(e) => setPayForm((f) => ({ ...f, reference_number: e.target.value }))} /></div>
            {payError && <div className="error-msg" style={{ marginBottom: 8 }}>{payError}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setPayingJob(null)} disabled={payLoading}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={recordPayment} disabled={!payForm.amount || payLoading}>{payLoading ? "Saving…" : "Record Payment"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ANALYTICS VIEW ───────────────────────────────────────────────────────────
function AnalyticsView({ dbJobs }) {
  if (dbJobs.length === 0)
    return (
      <div>
        <div className="page-header"><div className="page-title">Analytics</div></div>
        <div className="card" style={{ textAlign: "center", padding: "48px" }}><div style={{ fontSize: 14, color: T.textMuted }}>No jobs yet</div></div>
      </div>
    );

  const totalRev    = dbJobs.reduce((s, j) => s + Number(j.charged_total || 0), 0);
  const totalCost   = dbJobs.reduce((s, j) => s + Number(j.real_total || 0), 0);
  const totalProfit = dbJobs.reduce((s, j) => s + Number(j.profit_total || 0), 0);
  const avgMargin   = totalRev > 0 ? (totalProfit / totalRev) * 100 : 0;
  const byType = {};
  dbJobs.forEach((j) => { if (j.job_type) byType[j.job_type] = (byType[j.job_type] || 0) + 1; });
  const maxTypeCount = Math.max(...Object.values(byType), 1);
  const paidCount    = dbJobs.filter((j) => j.payment_status === "paid").length;
  const unpaidRev    = dbJobs.filter((j) => j.payment_status !== "paid").reduce((s, j) => s + Number(j.charged_total || 0), 0);

  return (
    <div>
      <div className="page-header"><div className="page-title">Analytics</div><div className="page-sub">All-time · {dbJobs.length} jobs</div></div>
      <div className="grid4" style={{ marginBottom: 20 }}>
        <div className="stat-card"><div className="stat-label">Revenue</div><div className="stat-val">₱{totalRev.toFixed(0)}</div></div>
        <div className="stat-card"><div className="stat-label">Real Cost</div><div className="stat-val">₱{totalCost.toFixed(0)}</div></div>
        <div className="stat-card"><div className="stat-label">Total Profit</div><div className="stat-val stat-profit">₱{totalProfit.toFixed(0)}</div></div>
        <div className="stat-card"><div className="stat-label">Avg Margin</div><div className="stat-val">{avgMargin.toFixed(1)}%</div></div>
      </div>
      <div className="grid2" style={{ marginBottom: 20 }}>
        <div className="stat-card"><div className="stat-label">Paid Jobs</div><div className="stat-val" style={{ color: T.accent }}>{paidCount} / {dbJobs.length}</div><div className="stat-sub">{dbJobs.length - paidCount} pending</div></div>
        <div className="stat-card"><div className="stat-label">Outstanding</div><div className="stat-val" style={{ color: unpaidRev > 0 ? T.warn : T.accent }}>₱{unpaidRev.toFixed(2)}</div><div className="stat-sub">Unpaid revenue</div></div>
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
  );
}
