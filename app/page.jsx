"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

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

const EMPTY_PRICING_CONFIG = {
  id: "default",
  electricity_rate: "",
  minimum_price: "",
  markup_multiplier: "",
  formula: "",
};

const JOB_TYPES = ["Standard Print", "Prototype", "Production Run", "Multicolor", "Functional Part", "Display Model"];
const JOB_STATUSES = ["pending", "queued", "printing", "post-processing", "done", "cancelled"];
const PAYMENT_STATUSES = ["unpaid", "partial", "paid", "refunded"];

const css = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
* { box-sizing: border-box; margin: 0; padding: 0; }
body, #root { background: ${T.bg}; min-height: 100vh; font-family: ${T.fontSans}; color: ${T.text}; }
.app { display: flex; min-height: 100vh; overflow: hidden; }
.sidebar { width: 220px; min-width: 220px; background: ${T.bgCard}; border-right: 1px solid ${T.border}; display: flex; flex-direction: column; }
.main { flex: 1; overflow-y: auto; height: 100vh; padding: 32px; }
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
.nav-bottom { padding: 16px 12px; border-top: 1px solid ${T.border}; }
.page-header { margin-bottom: 28px; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.page-title { font-size: 24px; font-weight: 600; color: ${T.text}; }
.page-sub { font-size: 13px; color: ${T.textMuted}; margin-top: 4px; }
.card { background: ${T.bgCard}; border: 1px solid ${T.border}; border-radius: 14px; padding: 24px; margin-bottom: 20px; }
.card-title { font-size: 13px; font-weight: 600; color: ${T.textMuted}; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
.card-title-dot { width: 6px; height: 6px; border-radius: 50%; background: ${T.accent}; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.chip { padding: 8px 14px; border-radius: 8px; border: 1.5px solid ${T.border}; font-size: 13px; cursor: pointer; transition: all 0.15s; color: ${T.textMuted}; background: transparent; text-align: center; }
.chip:hover { border-color: ${T.borderHi}; color: ${T.text}; }
.chip.selected { border-color: ${T.accent}; color: ${T.accent}; background: ${T.accentGlow}; }
.chip-printer, .filament-card { padding: 14px 16px; border-radius: 10px; border: 1.5px solid ${T.border}; cursor: pointer; transition: all 0.15s; background: ${T.bgInput}; }
.chip-printer:hover, .filament-card:hover { border-color: ${T.borderHi}; }
.chip-printer.selected, .filament-card.selected { border-color: ${T.accent}; background: ${T.accentGlow}; }
.printer-name, .fil-name { font-size: 14px; font-weight: 500; color: ${T.text}; }
.printer-meta, .fil-meta { font-size: 11px; color: ${T.textMuted}; margin-top: 3px; font-family: ${T.fontMono}; }
.badge { padding: 3px 8px; border-radius: 6px; font-size: 10px; font-weight: 600; letter-spacing: 0.5px; display: inline-flex; align-items: center; gap: 4px; }
.badge-accent { background: ${T.accentGlow}; color: ${T.accent}; }
.badge-warn { background: rgba(245,166,35,0.15); color: ${T.warn}; }
.badge-info { background: rgba(91,156,246,0.15); color: ${T.info}; }
.badge-purple { background: rgba(155,125,255,0.15); color: ${T.purple}; }
.badge-danger { background: rgba(255,92,92,0.15); color: ${T.danger}; }
label { font-size: 12px; color: ${T.textMuted}; display: block; margin-bottom: 6px; letter-spacing: 0.3px; }
input[type=text], input[type=email], input[type=password], input[type=number], input[type=date], select, textarea {
  width: 100%; padding: 9px 12px; background: ${T.bgInput}; border: 1px solid ${T.border};
  border-radius: 8px; color: ${T.text}; font-size: 13px; font-family: ${T.fontSans}; outline: none; transition: border 0.15s;
}
input:focus, select:focus, textarea:focus { border-color: ${T.accent}; }
select option { background: ${T.bgCard}; }
.input-group { margin-bottom: 14px; }
.input-row { display: flex; gap: 12px; margin-bottom: 14px; }
.input-row .input-group { flex: 1; margin-bottom: 0; }
.btn { padding: 10px 20px; border-radius: 9px; font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.15s; border: none; font-family: ${T.fontSans}; }
.btn-primary { background: ${T.accent}; color: #000; }
.btn-primary:hover { background: #00f5ae; transform: translateY(-1px); }
.btn-primary:disabled { background: ${T.border}; color: ${T.textDim}; cursor: not-allowed; transform: none; }
.btn-ghost { background: transparent; border: 1px solid ${T.border}; color: ${T.textMuted}; }
.btn-ghost:hover { border-color: ${T.borderHi}; color: ${T.text}; }
.btn-danger { background: transparent; border: 1px solid rgba(255,92,92,0.3); color: ${T.danger}; }
.btn-danger:hover { background: rgba(255,92,92,0.1); }
.btn-row { display: flex; justify-content: space-between; align-items: center; margin-top: 24px; gap: 10px; }
.stepper { display: flex; align-items: center; gap: 0; margin-bottom: 24px; overflow-x: auto; }
.step-item { display: flex; align-items: center; gap: 0; }
.step-circle { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; font-family: ${T.fontMono}; border: 1.5px solid ${T.border}; color: ${T.textDim}; background: ${T.bgCard}; transition: all 0.2s; flex-shrink: 0; }
.step-circle.done { border-color: ${T.accentDim}; background: ${T.accentDim}; color: #000; }
.step-circle.active { border-color: ${T.accent}; color: ${T.accent}; background: ${T.accentGlow}; box-shadow: 0 0 0 3px rgba(0,229,160,0.15); }
.step-label { font-size: 11px; color: ${T.textDim}; margin: 0 6px; white-space: nowrap; display: none; }
.step-label.active { color: ${T.accent}; display: block; }
.step-connector { width: 24px; height: 1px; background: ${T.border}; flex-shrink: 0; }
.step-connector.done { background: ${T.accentDim}; }
.alloc-row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid ${T.border}; }
.alloc-row:last-child { border-bottom: none; }
.alloc-name { font-size: 13px; font-weight: 500; color: ${T.text}; min-width: 160px; }
.alloc-pct { font-family: ${T.fontMono}; font-size: 14px; color: ${T.accent}; min-width: 42px; text-align: right; }
input[type=range] { -webkit-appearance: none; width: 100%; height: 4px; background: ${T.border}; border-radius: 2px; border: none; padding: 0; }
input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%; background: ${T.accent}; cursor: pointer; }
.table { width: 100%; border-collapse: collapse; }
.table th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; color: ${T.textDim}; padding: 8px 12px; text-align: left; border-bottom: 1px solid ${T.border}; }
.table td { font-size: 13px; padding: 10px 12px; border-bottom: 1px solid ${T.border}; color: ${T.textMuted}; vertical-align: top; }
.table td:first-child { color: ${T.text}; }
.tag { padding: 3px 8px; border-radius: 5px; font-size: 10px; font-weight: 500; background: ${T.border}; color: ${T.textMuted}; margin-right: 4px; }
.stat-card { background: ${T.bgInput}; border: 1px solid ${T.border}; border-radius: 10px; padding: 14px 16px; }
.stat-label { font-size: 11px; color: ${T.textMuted}; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.8px; }
.stat-val { font-size: 22px; font-weight: 600; color: ${T.text}; font-family: ${T.fontMono}; }
.stat-sub { font-size: 11px; color: ${T.textDim}; margin-top: 3px; }
.receipt { background: #fff; color: #111; border-radius: 10px; padding: 28px 24px; font-family: 'Courier New', monospace; max-width: 360px; margin: 0 auto; }
.receipt h2 { text-align: center; font-size: 15px; font-weight: 700; letter-spacing: 1px; margin-bottom: 4px; }
.receipt .sub { text-align: center; font-size: 11px; color: #555; margin-bottom: 16px; }
.receipt hr { border: none; border-top: 1px dashed #ccc; margin: 12px 0; }
.receipt .r-row { display: flex; justify-content: space-between; gap: 16px; font-size: 12px; margin: 4px 0; }
.receipt .r-total { display: flex; justify-content: space-between; font-size: 14px; font-weight: 700; margin-top: 8px; }
.error-msg { font-size: 12px; color: ${T.danger}; margin-top: 5px; }
.validation-gate, .db-error { padding: 10px 14px; background: rgba(255,92,92,0.08); border: 1px solid rgba(255,92,92,0.2); border-radius: 8px; font-size: 12px; color: ${T.danger}; margin-bottom: 16px; }
.notice { padding: 10px 14px; background: ${T.accentGlow}; border: 1px solid ${T.accentDim}; border-radius: 8px; font-size: 12px; color: ${T.accent}; margin-bottom: 16px; }
.loading-screen { display: flex; align-items: center; justify-content: center; height: 100vh; flex-direction: column; gap: 14px; }
.loading-spinner { width: 32px; height: 32px; border: 2px solid ${T.border}; border-top-color: ${T.accent}; border-radius: 50%; animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: ${T.bgCard}; border: 1px solid ${T.border}; border-radius: 16px; padding: 28px; width: 520px; max-width: 92vw; max-height: 90vh; overflow: auto; }
.modal h3 { font-size: 16px; font-weight: 600; margin-bottom: 20px; }
.search-box { position: relative; }
.search-box input { padding-left: 32px; }
.search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: ${T.textDim}; font-size: 14px; }
.filament-color-dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
@media (max-width: 860px) {
  .app { display: block; padding-bottom: 76px; }
  .main { height: auto; min-height: 100vh; padding: 16px; }
  .sidebar { position: fixed; left: 0; right: 0; bottom: 0; top: auto; z-index: 80; width: 100%; min-width: 0; height: 68px; border-right: none; border-top: 1px solid ${T.border}; box-shadow: 0 -12px 30px rgba(0,0,0,0.28); }
  .logo, .nav-label, .nav-bottom { display: none; }
  .nav-section { width: 100%; display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px; padding: 8px; }
  .nav-item { justify-content: center; text-align: center; font-size: 10px; line-height: 1.1; padding: 8px 4px; margin: 0; border-radius: 12px; min-height: 48px; }
  .nav-dot { display: none; }
  .grid2, .grid3, .grid4 { grid-template-columns: 1fr !important; }
  .input-row { flex-direction: column; gap: 0; }
  .table { min-width: 900px; }
  .card:has(.table) { overflow-x: auto; }
  .btn-row { position: sticky; bottom: 78px; z-index: 20; background: linear-gradient(180deg, rgba(13,15,20,0), ${T.bg} 22%); padding-top: 18px; }
  .page-header { display: block; }
}
@media print {
  body, #root { background: #fff; }
  .sidebar, .page-header, .btn-row, button, .no-print { display: none !important; }
  .main { padding: 0; height: auto; }
  .receipt { box-shadow: none; border-radius: 0; }
}
`;

const colorMap = {
  "Jade White": "#e8f5e9",
  "Onyx Black": "#212121",
  Gold: "#ffd700",
  Clear: "#e3f2fd",
  "Bambu Green": "#4caf50",
  "Marble White": "#f5f5f5",
};
const getFilColor = (color) => colorMap[color] || "#888";
const peso = (n) => `₱${Number(n || 0).toFixed(2)}`;
const pct = (n) => `${Number(n || 0).toFixed(1)}%`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isNumber = (v) => Number.isFinite(Number(v));
const requiredNumber = (v) => isNumber(v) && Number(v) >= 0;

function dbPrinterToInternal(row) {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    wattage: Number(row.wattage),
    multicolor: Boolean(row.multicolor),
    buildVol: row.build_volume,
    _p: {
      base: Number(row.base_rate),
      eff: Number(row.efficiency),
      labor: Number(row.labor),
      mult: Number(row.multiplier),
    },
  };
}

function evaluatePricingFormula(formula, variables) {
  const safeFormula = String(formula || "").trim();
  if (!safeFormula) throw new Error("Pricing formula is required.");
  if (!/^[0-9a-zA-Z_+\-*/()., %]+$/.test(safeFormula)) throw new Error("Formula contains unsupported characters.");
  const keys = Object.keys(variables);
  const values = keys.map((key) => variables[key]);
  const fn = new Function(...keys, `"use strict"; return (${safeFormula});`);
  const result = fn(...values);
  if (!Number.isFinite(Number(result))) throw new Error("Formula did not return a valid number.");
  return Number(result);
}

function computeEngine({ printers, filament, grams, hours, pricingConfig }, printerDB) {
  if (!filament || !grams || !hours || !printers?.length) return { ok: false, message: "Complete printer, filament, grams, and hours first." };
  if (!requiredNumber(filament.true_cost_per_kg) || !requiredNumber(filament.selling_price_per_kg)) {
    return { ok: false, message: "Selected filament needs true_cost_per_kg and selling_price_per_kg." };
  }
  if (!requiredNumber(pricingConfig.electricity_rate) || !requiredNumber(pricingConfig.minimum_price) || !requiredNumber(pricingConfig.markup_multiplier) || !pricingConfig.formula) {
    return { ok: false, message: "Pricing settings are incomplete. Set id='default' in Pricing." };
  }

  const g = Number(grams);
  const h = Number(hours);
  const filamentReal = (g / 1000) * Number(filament.true_cost_per_kg);
  const filamentCharged = (g / 1000) * Number(filament.selling_price_per_kg);

  let elecReal = 0;
  let elecCharged = 0;
  let printerReal = 0;
  let printerCharged = 0;
  let weightedMachineRate = 0;
  let weightedPowerKw = 0;
  let weightedPrinterMultiplier = 0;
  let weightedEfficiencyModifier = 0;
  let weightedLaborFactor = 0;
  const perPrinterBreakdown = [];

  for (const alloc of printers) {
    const p = printerDB[alloc.id];
    if (!p) continue;
    const share = Number(alloc.pct) / 100;
    const pHours = h * share;
    const pGrams = g * share;
    const powerKw = p.wattage / 1000;
    const er = powerKw * pHours * Number(pricingConfig.electricity_rate);
    const ec = er;
    const pr = pHours * p._p.base;
    const pc = pr * p._p.mult * p._p.labor * p._p.eff;

    weightedMachineRate += p._p.base * share;
    weightedPowerKw += powerKw * share;
    weightedPrinterMultiplier += p._p.mult * share;
    weightedEfficiencyModifier += p._p.eff * share;
    weightedLaborFactor += p._p.labor * share;

    elecReal += er;
    elecCharged += ec;
    printerReal += pr;
    printerCharged += pc;
    perPrinterBreakdown.push({
      id: p.id,
      name: p.name,
      pct: Number(alloc.pct),
      hours: +pHours.toFixed(2),
      grams: +pGrams.toFixed(1),
      elec: { real: +er.toFixed(2), charged: +ec.toFixed(2) },
      printer: { real: +pr.toFixed(2), charged: +pc.toFixed(2) },
    });
  }

  const totalReal = filamentReal + elecReal + printerReal;
  const defaultChargedTotal = filamentCharged + elecCharged + printerCharged;
  let computedChargedTotal = defaultChargedTotal;
  let formulaError = "";

  try {
    computedChargedTotal = evaluatePricingFormula(pricingConfig.formula, {
      grams: g,
      hours: h,
      filament_real: filamentReal,
      filament_charged: filamentCharged,
      electricity_real: elecReal,
      electricity_charged: elecCharged,
      printer_real: printerReal,
      printer_charged: printerCharged,
      real_total: totalReal,
      default_charged_total: defaultChargedTotal,
      machine_rate: weightedMachineRate,
      power_kw: weightedPowerKw,
      electricity_rate: Number(pricingConfig.electricity_rate),
      printer_multiplier: weightedPrinterMultiplier,
      efficiency_modifier: weightedEfficiencyModifier,
      labor_factor: weightedLaborFactor,
      markup_multiplier: Number(pricingConfig.markup_multiplier),
      minimum_price: Number(pricingConfig.minimum_price),
    });
  } catch (err) {
    formulaError = err.message || "Formula error.";
  }

  if (formulaError) return { ok: false, message: formulaError };

  const totalCharged = Math.max(computedChargedTotal, Number(pricingConfig.minimum_price));
  const profit = totalCharged - totalReal;
  const margin = totalCharged > 0 ? (profit / totalCharged) * 100 : 0;
  const printerList = Object.values(printerDB);
  const lowestCost = printerList.length ? printerList.reduce((a, b) => (a._p.base < b._p.base ? a : b)).name : "—";
  const fastest = printerList.length ? printerList.reduce((a, b) => (a._p.eff > b._p.eff ? a : b)).name : "—";
  const highestProfit = printerList.length ? printerList.reduce((a, b) => (a._p.mult > b._p.mult ? a : b)).name : "—";

  return {
    ok: true,
    filament: { real: +filamentReal.toFixed(2), charged: +filamentCharged.toFixed(2), profit: +(filamentCharged - filamentReal).toFixed(2) },
    electricity: { real: +elecReal.toFixed(2), charged: +elecCharged.toFixed(2), profit: +(elecCharged - elecReal).toFixed(2) },
    printer_usage: { real: +printerReal.toFixed(2), charged: +printerCharged.toFixed(2), profit: +(printerCharged - printerReal).toFixed(2) },
    totals: { real: +totalReal.toFixed(2), charged: +totalCharged.toFixed(2), profit: +profit.toFixed(2), margin: +margin.toFixed(1) },
    per_printer: perPrinterBreakdown,
    formula_error: "",
    recommendation: { lowest_cost: lowestCost, fastest, highest_profit: highestProfit },
  };
}

function statusBadge(status) {
  if (status === "done" || status === "paid") return "badge badge-accent";
  if (status === "printing" || status === "partial") return "badge badge-warn";
  if (status === "cancelled" || status === "refunded") return "badge badge-danger";
  if (status === "post-processing") return "badge badge-purple";
  return "badge badge-info";
}

function setupMissing({ printers, filaments, pricingConfig }) {
  const issues = [];
  if (!printers.length) issues.push("Add at least one printer.");
  if (!filaments.length) issues.push("Add at least one active filament.");
  if (!pricingConfig?.formula) issues.push("Create pricing_settings row with id='default'.");
  if (!requiredNumber(pricingConfig?.electricity_rate)) issues.push("Set electricity_rate.");
  if (!requiredNumber(pricingConfig?.minimum_price)) issues.push("Set minimum_price.");
  if (!requiredNumber(pricingConfig?.markup_multiplier)) issues.push("Set markup_multiplier.");
  return issues;
}

export default function App() {
  const [view, setView] = useState("pos");
  const [step, setStep] = useState(1);
  const [session, setSession] = useState(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");

  const [filaments, setFilaments] = useState([]);
  const [printerRows, setPrinterRows] = useState([]);
  const [printerDB, setPrinterDB] = useState({});
  const [pricingConfig, setPricingConfig] = useState(EMPTY_PRICING_CONFIG);
  const [jobs, setJobs] = useState([]);
  const [dbLoading, setDbLoading] = useState(true);
  const [dbError, setDbError] = useState("");

  const [jobType, setJobType] = useState("");
  const [selectedPrinters, setSelectedPrinters] = useState([]);
  const [selectedFil, setSelectedFil] = useState(null);
  const [grams, setGrams] = useState("");
  const [hours, setHours] = useState("");
  const [costResult, setCostResult] = useState(null);
  const [customPrice, setCustomPrice] = useState("");
  const [clientName, setClientName] = useState("");
  const [deadline, setDeadline] = useState("");
  const [notes, setNotes] = useState("");
  const [parts, setParts] = useState("");
  const [showReceipt, setShowReceipt] = useState(false);
  const [receiptJob, setReceiptJob] = useState(null);
  const [filSearch, setFilSearch] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);

  const loadAll = useCallback(async () => {
    setDbLoading(true);
    setDbError("");
    try {
      const [filRes, prRes, psRes, jobsRes] = await Promise.all([
        supabase.from("filaments").select("*").eq("active", true).order("brand"),
        supabase.from("printers").select("*").eq("active", true).order("name"),
        supabase.from("pricing_settings").select("*").eq("id", "default").maybeSingle(),
        supabase
          .from("jobs")
          .select("*, filaments(*), job_printer_allocations(*, printers(*))")
          .order("created_at", { ascending: false }),
      ]);
      if (filRes.error) throw new Error(`Filaments: ${filRes.error.message}`);
      if (prRes.error) throw new Error(`Printers: ${prRes.error.message}`);
      if (psRes.error) throw new Error(`Pricing: ${psRes.error.message}`);
      if (jobsRes.error) throw new Error(`Jobs: ${jobsRes.error.message}`);

      setFilaments(filRes.data || []);
      setPrinterRows(prRes.data || []);
      const dbMap = {};
      for (const row of prRes.data || []) dbMap[row.id] = dbPrinterToInternal(row);
      setPrinterDB(dbMap);
      setPricingConfig(psRes.data || EMPTY_PRICING_CONFIG);
      setJobs(jobsRes.data || []);
    } catch (err) {
      setDbError(err.message || "Failed to load data from database.");
    } finally {
      setDbLoading(false);
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session || null);
      setDbLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session) loadAll();
  }, [session, loadAll]);

  const activeFilaments = useMemo(
    () => filaments.filter((f) => f.active && (!filSearch || `${f.brand} ${f.type} ${f.color} ${f.finish}`.toLowerCase().includes(filSearch.toLowerCase()))),
    [filaments, filSearch]
  );

  const togglePrinter = (id) => {
    setSelectedPrinters((prev) => {
      const has = prev.find((p) => p.id === id);
      if (has) return rebalance(prev.filter((p) => p.id !== id));
      return rebalance([...prev, { id, pct: 100 }]);
    });
  };

  const rebalance = (list) => {
    if (!list.length) return [];
    const eq = Math.floor(100 / list.length);
    const rem = 100 - eq * list.length;
    return list.map((p, i) => ({ ...p, pct: eq + (i === 0 ? rem : 0) }));
  };

  const setPrinterPct = (id, val) => {
    setSelectedPrinters((prev) => {
      const idx = prev.findIndex((p) => p.id === id);
      if (idx < 0 || prev.length < 2) return prev;
      const next = prev.map((p) => ({ ...p }));
      const delta = Number(val) - next[idx].pct;
      next[idx].pct = Number(val);
      const others = next.filter((_, i) => i !== idx);
      const total = others.reduce((s, p) => s + p.pct, 0);
      if (total > 0) others.forEach((p) => { p.pct = clamp(Math.round(p.pct - delta * (p.pct / total)), 0, 100); });
      const sum = next.reduce((s, p) => s + p.pct, 0);
      if (sum !== 100) next[0].pct += 100 - sum;
      return next;
    });
  };

  useEffect(() => {
    if (step === 5 && selectedFil && selectedPrinters.length && Number(grams) > 0 && Number(hours) > 0) {
      const result = computeEngine({ printers: selectedPrinters, filament: selectedFil, grams: Number(grams), hours: Number(hours), pricingConfig }, printerDB);
      setCostResult(result.ok ? result : null);
      setSaveError(result.ok ? "" : result.message);
      if (result.ok) setCustomPrice(String(result.totals.charged));
    }
  }, [step, selectedFil, selectedPrinters, grams, hours, pricingConfig, printerDB]);

  const setupIssues = setupMissing({ printers: printerRows, filaments, pricingConfig });

  const stepValid = useCallback(() => {
    switch (step) {
      case 1: return Boolean(jobType);
      case 2: return selectedPrinters.length > 0 && selectedPrinters.reduce((s, p) => s + Number(p.pct), 0) === 100;
      case 3: return Boolean(selectedFil);
      case 4: return Number(grams) > 0 && Number(hours) > 0;
      case 5: return Boolean(costResult);
      case 6: return Number(customPrice) >= 0;
      case 7: return clientName.trim().length > 0;
      case 8: return true;
      default: return false;
    }
  }, [step, jobType, selectedPrinters, selectedFil, grams, hours, costResult, customPrice, clientName]);

  const goNext = () => { if (stepValid()) setStep((s) => Math.min(8, s + 1)); };
  const goBack = () => { setStep((s) => Math.max(1, s - 1)); if (step <= 5) setCostResult(null); };

  const finalizeJob = async () => {
    if (!costResult || !selectedFil) return;
    setSaving(true);
    setSaveError("");
    try {
      const finalPrice = Number(customPrice || costResult.totals.charged);
      const { data: jobData, error: jobErr } = await supabase
        .from("jobs")
        .insert({
          client_name: clientName.trim(),
          job_type: jobType,
          filament_id: selectedFil.id,
          parts,
          total_grams: Number(grams),
          total_hours: Number(hours),
          charged_total: finalPrice,
          real_total: costResult.totals.real,
          profit_total: finalPrice - costResult.totals.real,
          deadline: deadline || null,
          notes: notes || null,
          cost_result: { ...costResult, totals: { ...costResult.totals, charged: finalPrice, profit: finalPrice - costResult.totals.real } },
          payment_status: "unpaid",
          status: "pending",
        })
        .select("*, filaments(*), job_printer_allocations(*, printers(*))")
        .single();
      if (jobErr) throw new Error(jobErr.message);

      const allocations = selectedPrinters.map((p) => ({ job_id: jobData.id, printer_id: p.id, percentage: p.pct }));
      const { error: allocErr } = await supabase.from("job_printer_allocations").insert(allocations);
      if (allocErr) throw new Error(allocErr.message);

      await loadAll();
      setReceiptJob({ ...jobData, filaments: selectedFil, job_printer_allocations: allocations.map((a) => ({ ...a, printers: printerRows.find((p) => p.id === a.printer_id) })) });
      setShowReceipt(true);
      setView("pos");
    } catch (err) {
      setSaveError(err.message || "Failed to save job.");
    } finally {
      setSaving(false);
    }
  };

  const resetJob = () => {
    setStep(1);
    setJobType("");
    setSelectedPrinters([]);
    setSelectedFil(null);
    setGrams("");
    setHours("");
    setCostResult(null);
    setCustomPrice("");
    setClientName("");
    setDeadline("");
    setNotes("");
    setParts("");
    setShowReceipt(false);
    setReceiptJob(null);
    setSaveError("");
  };

  const signIn = async (e) => {
    e.preventDefault();
    setAuthError("");
    const { error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword });
    if (error) setAuthError(error.message);
  };

  if (!session) {
    return (
      <>
        <style>{css}</style>
        <div className="loading-screen" style={{ padding: 20 }}>
          <form className="card" style={{ width: 420, maxWidth: "100%" }} onSubmit={signIn}>
            <div className="page-title" style={{ marginBottom: 6 }}>TechCraft POS Login</div>
            <div className="page-sub" style={{ marginBottom: 18 }}>Use your Supabase Auth staff account.</div>
            <div className="input-group"><label>Email</label><input type="email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} /></div>
            <div className="input-group"><label>Password</label><input type="password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} /></div>
            {authError && <div className="validation-gate">{authError}</div>}
            <button className="btn btn-primary" style={{ width: "100%" }} type="submit">Sign In</button>
          </form>
        </div>
      </>
    );
  }

  if (dbLoading) {
    return <><style>{css}</style><div className="loading-screen"><div className="loading-spinner" /><div style={{ fontSize: 13, color: T.textMuted }}>Loading data…</div></div></>;
  }

  const nav = [
    { id: "pos", label: "New Job" },
    { id: "orders", label: "Job Orders" },
    { id: "inventory", label: "Filaments" },
    { id: "printers", label: "Printers" },
    { id: "analytics", label: "Analytics" },
    { id: "settings", label: "Pricing" },
  ];

  return (
    <>
      <style>{css}</style>
      <div className="app">
        <aside className="sidebar">
          <div className="logo"><div className="logo-mark">3D Printing POS</div><div className="logo-name">TechCraft Innovator</div></div>
          <div className="nav-section">
            <div className="nav-label">Workflow</div>
            {nav.map((n) => <div key={n.id} className={`nav-item ${view === n.id ? "active" : ""}`} onClick={() => { setView(n.id); if (n.id !== "pos") setShowReceipt(false); }}><span className="nav-dot" />{n.label}</div>)}
          </div>
          <div className="nav-bottom">
            <div style={{ fontSize: 11, color: T.textDim, fontFamily: T.fontMono }}>{jobs.length} saved orders</div>
            <div style={{ fontSize: 11, color: T.textDim, marginTop: 2 }}>{filaments.filter((f) => f.active).length} active filaments</div>
            <button className="btn btn-ghost" style={{ width: "100%", marginTop: 12, padding: "7px 10px", fontSize: 11 }} onClick={() => supabase.auth.signOut()}>Sign Out</button>
          </div>
        </aside>
        <main className="main">
          {dbError && <div className="db-error">⚠ Database error: {dbError}</div>}
          {setupIssues.length > 0 && view === "pos" && <SetupWarning issues={setupIssues} setView={setView} />}

          {view === "pos" && !showReceipt && (
            <POSView
              step={step} stepValid={stepValid} goNext={goNext} goBack={goBack}
              jobType={jobType} setJobType={setJobType}
              selectedPrinters={selectedPrinters} togglePrinter={togglePrinter} setPrinterPct={setPrinterPct} printerDB={printerDB} printerRows={printerRows}
              filaments={activeFilaments} filSearch={filSearch} setFilSearch={setFilSearch} selectedFil={selectedFil} setSelectedFil={setSelectedFil}
              grams={grams} setGrams={setGrams} hours={hours} setHours={setHours}
              costResult={costResult} customPrice={customPrice} setCustomPrice={setCustomPrice}
              clientName={clientName} setClientName={setClientName} deadline={deadline} setDeadline={setDeadline}
              notes={notes} setNotes={setNotes} parts={parts} setParts={setParts}
              finalizeJob={finalizeJob} saving={saving} saveError={saveError}
              setupIssues={setupIssues}
            />
          )}
          {view === "pos" && showReceipt && receiptJob && <ReceiptView job={receiptJob} onNew={resetJob} />}
          {view === "orders" && <JobOrdersView jobs={jobs} setJobs={setJobs} reload={loadAll} />}
          {view === "inventory" && <InventoryView filaments={filaments} reload={loadAll} />}
          {view === "printers" && <PrintersView printerRows={printerRows} reload={loadAll} />}
          {view === "settings" && <PricingSettingsView pricingConfig={pricingConfig} setPricingConfig={setPricingConfig} reload={loadAll} />}
          {view === "analytics" && <AnalyticsView jobs={jobs} />}
        </main>
      </div>
    </>
  );
}

function SetupWarning({ issues, setView }) {
  return (
    <div className="validation-gate">
      <strong>Setup required before creating jobs:</strong>
      <ul style={{ marginTop: 8, marginLeft: 18 }}>{issues.map((x) => <li key={x}>{x}</li>)}</ul>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="btn btn-ghost" onClick={() => setView("printers")}>Printers</button>
        <button className="btn btn-ghost" onClick={() => setView("inventory")}>Filaments</button>
        <button className="btn btn-ghost" onClick={() => setView("settings")}>Pricing</button>
      </div>
    </div>
  );
}

function POSView(props) {
  const { step, stepValid, goNext, goBack, finalizeJob, saving, saveError, setupIssues } = props;
  return (
    <div>
      <div className="page-header"><div><div className="page-title">New Print Job</div><div className="page-sub">Create the order once. It will appear in Job Orders from the database.</div></div></div>
      <Stepper step={step} />
      {step === 1 && <Step1 {...props} />}
      {step === 2 && <Step2 {...props} />}
      {step === 3 && <Step3 {...props} />}
      {step === 4 && <Step4 {...props} />}
      {step === 5 && <Step5 {...props} />}
      {step === 6 && <Step6 {...props} />}
      {step === 7 && <Step7 {...props} />}
      {step === 8 && <Step8 {...props} />}
      {saveError && <div className="validation-gate">{saveError}</div>}
      <div className="btn-row">
        <button className="btn btn-ghost" onClick={goBack} disabled={step === 1 || saving}>← Back</button>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {!stepValid() && step < 8 && <span style={{ fontSize: 12, color: T.danger }}>Complete this step to continue</span>}
          {step < 8 && <button className="btn btn-primary" onClick={goNext} disabled={!stepValid() || saving || setupIssues.length > 0}>Continue →</button>}
          {step === 8 && <button className="btn btn-primary" onClick={finalizeJob} disabled={saving}>{saving ? "Saving…" : "Finalize & Save Order"}</button>}
        </div>
      </div>
    </div>
  );
}

function Stepper({ step }) {
  const steps = ["Job Type", "Printers", "Filament", "Parameters", "Cost Engine", "Pricing", "Metadata", "Confirm"];
  return <div className="stepper">{steps.map((label, i) => { const id = i + 1; return <div key={label} className="step-item"><div className={`step-circle ${step > id ? "done" : step === id ? "active" : ""}`}>{step > id ? "✓" : id}</div><span className={`step-label ${step === id ? "active" : ""}`}>{label}</span>{i < steps.length - 1 && <div className={`step-connector ${step > id ? "done" : ""}`} />}</div>; })}</div>;
}

function Step1({ jobType, setJobType }) {
  return <div className="card"><div className="card-title"><span className="card-title-dot" />Job Type</div><div className="grid3">{JOB_TYPES.map((t) => <div key={t} className={`chip ${jobType === t ? "selected" : ""}`} onClick={() => setJobType(t)}>{t}</div>)}</div></div>;
}

function Step2({ selectedPrinters, togglePrinter, setPrinterPct, printerDB, printerRows }) {
  const allocTotal = selectedPrinters.reduce((s, p) => s + Number(p.pct), 0);
  return <div className="card"><div className="card-title"><span className="card-title-dot" />Printer Assignment</div>{printerRows.length === 0 ? <p style={{ fontSize: 13, color: T.textMuted }}>No active printers found.</p> : <div className="grid2" style={{ marginBottom: 20 }}>{printerRows.map((p) => <div key={p.id} className={`chip-printer ${selectedPrinters.find((s) => s.id === p.id) ? "selected" : ""}`} onClick={() => togglePrinter(p.id)}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}><div className="printer-name">{p.name}</div><div style={{ display: "flex", gap: 4 }}>{p.multicolor && <span className="badge badge-purple">AMS</span>}<span className="badge badge-info">{p.wattage}W</span></div></div><div className="printer-meta">{p.brand || "—"} · {p.build_volume || "—"}</div></div>)}</div>}{selectedPrinters.length > 0 && <><div className="card-title" style={{ marginTop: 8 }}><span className="card-title-dot" />Allocation</div>{selectedPrinters.map((sp) => { const p = printerDB[sp.id]; if (!p) return null; return <div key={sp.id} className="alloc-row"><span className="alloc-name">{p.name}</span><div style={{ flex: 1 }}><input type="range" min={selectedPrinters.length > 1 ? 5 : 100} max={selectedPrinters.length > 1 ? 95 : 100} step={5} value={sp.pct} onChange={(e) => setPrinterPct(sp.id, +e.target.value)} /></div><span className="alloc-pct">{sp.pct}%</span></div>; })}<div style={{ fontSize: 12, color: allocTotal === 100 ? T.accent : T.danger }}>Total: {allocTotal}%</div></>}</div>;
}

function Step3({ filaments, filSearch, setFilSearch, selectedFil, setSelectedFil }) {
  return <div className="card"><div className="card-title"><span className="card-title-dot" />Filament Selection</div><div className="search-box input-group"><span className="search-icon">⌕</span><input type="text" placeholder="Search by brand, type, color…" value={filSearch} onChange={(e) => setFilSearch(e.target.value)} /></div>{filaments.length === 0 ? <p style={{ fontSize: 13, color: T.textDim, textAlign: "center", padding: "20px 0" }}>No active filaments found.</p> : <div className="grid2">{filaments.map((f) => <div key={f.id} className={`filament-card ${selectedFil?.id === f.id ? "selected" : ""}`} onClick={() => setSelectedFil(f)}><div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}><span className="filament-color-dot" style={{ background: getFilColor(f.color), border: "1px solid rgba(255,255,255,0.1)" }} /><span className="fil-name">{f.color}</span><span className="badge badge-info">{f.type}</span></div><div className="fil-meta">{f.brand} · {f.finish}</div><div className="fil-meta">true ₱{Number(f.true_cost_per_kg).toFixed(2)}/kg · sell ₱{Number(f.selling_price_per_kg).toFixed(2)}/kg</div></div>)}</div>}</div>;
}

function Step4({ grams, setGrams, hours, setHours, selectedFil }) {
  return <div className="card"><div className="card-title"><span className="card-title-dot" />Print Parameters</div>{selectedFil && <div className="notice">{selectedFil.brand} {selectedFil.type} — {selectedFil.color}</div>}<div className="input-row"><div className="input-group"><label>Filament Usage (grams)</label><input type="number" min="0" step="0.01" value={grams} onChange={(e) => setGrams(e.target.value)} /></div><div className="input-group"><label>Print Duration (hours)</label><input type="number" min="0" step="0.01" value={hours} onChange={(e) => setHours(e.target.value)} /></div></div></div>;
}

function Step5({ costResult }) {
  if (!costResult) return <div className="card"><p style={{ color: T.textMuted, fontSize: 13 }}>Cost engine is waiting for complete setup values.</p></div>;
  const items = [{ label: "Filament", ...costResult.filament }, { label: "Electricity", ...costResult.electricity }, { label: "Printer Usage", ...costResult.printer_usage }];
  return <div><div className="card"><div className="card-title"><span className="card-title-dot" />Cost Breakdown</div><table className="table"><thead><tr><th>Component</th><th>Real Cost</th><th>Charged</th><th>Profit</th></tr></thead><tbody>{items.map((item) => <tr key={item.label}><td>{item.label}</td><td>{peso(item.real)}</td><td>{peso(item.charged)}</td><td style={{ color: T.accent }}>+{peso(item.profit)}</td></tr>)}<tr><td><strong>Total</strong></td><td>{peso(costResult.totals.real)}</td><td><strong>{peso(costResult.totals.charged)}</strong></td><td style={{ color: T.accent }}><strong>{peso(costResult.totals.profit)}</strong></td></tr></tbody></table></div><div className="grid3"><div className="stat-card"><div className="stat-label">Lowest Cost</div><div className="stat-val" style={{ fontSize: 15 }}>{costResult.recommendation.lowest_cost}</div></div><div className="stat-card"><div className="stat-label">Fastest</div><div className="stat-val" style={{ fontSize: 15 }}>{costResult.recommendation.fastest}</div></div><div className="stat-card"><div className="stat-label">Highest Profit</div><div className="stat-val" style={{ fontSize: 15 }}>{costResult.recommendation.highest_profit}</div></div></div></div>;
}

function Step6({ costResult, customPrice, setCustomPrice }) {
  if (!costResult) return null;
  const finalPrice = Number(customPrice || costResult.totals.charged);
  const profit = finalPrice - costResult.totals.real;
  return <div className="card"><div className="card-title"><span className="card-title-dot" />Pricing Review</div><div className="grid2"><div className="stat-card"><div className="stat-label">Suggested Price</div><div className="stat-val">{peso(costResult.totals.charged)}</div></div><div className="stat-card"><div className="stat-label">Your Price</div><div className="stat-val" style={{ color: T.accent }}>{peso(finalPrice)}</div></div></div><div className="input-group" style={{ marginTop: 16 }}><label>Final Price (₱)</label><input type="number" value={customPrice} min={0} step={0.01} onChange={(e) => setCustomPrice(e.target.value)} /></div><div className="notice">Profit at this price: <strong>{peso(profit)}</strong></div></div>;
}

function Step7({ clientName, setClientName, deadline, setDeadline, notes, setNotes, parts, setParts }) {
  return <div className="card"><div className="card-title"><span className="card-title-dot" />Job Metadata</div><div className="input-row"><div className="input-group"><label>Client Name *</label><input type="text" value={clientName} onChange={(e) => setClientName(e.target.value)} /></div><div className="input-group"><label>Deadline</label><input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></div></div><div className="input-group"><label>Parts / Items</label><input type="text" value={parts} onChange={(e) => setParts(e.target.value)} placeholder="e.g. 3x bracket, 1x base" /></div><div className="input-group"><label>Notes</label><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></div></div>;
}

function Step8({ jobType, selectedPrinters, printerDB, selectedFil, grams, hours, costResult, customPrice, clientName, deadline, parts }) {
  const finalPrice = Number(customPrice || costResult?.totals.charged || 0);
  const rows = [
    ["Job Type", jobType],
    ["Printers", selectedPrinters.map((p) => `${printerDB[p.id]?.name || p.id} (${p.pct}%)`).join(", ")],
    ["Filament", selectedFil ? `${selectedFil.brand} ${selectedFil.type} — ${selectedFil.color}` : "—"],
    ["Parameters", `${grams}g · ${hours}h`],
    ["Total", peso(finalPrice)],
    ["Client", clientName],
    ["Deadline", deadline || "None"],
    ["Parts", parts || "Not specified"],
  ];
  return <div className="card"><div className="card-title"><span className="card-title-dot" />Final Confirmation</div>{rows.map(([k, v]) => <div key={k} style={{ padding: "10px 0", borderBottom: `1px solid ${T.border}` }}><div style={{ fontSize: 12, color: T.textMuted }}>{k}</div><div style={{ fontSize: 13, color: T.text, fontWeight: 500, marginTop: 2 }}>{v}</div></div>)}<div className="notice" style={{ marginTop: 16 }}>This will save to the <strong>jobs</strong> table and appear in Job Orders.</div></div>;
}

function ReceiptView({ job, onNew }) {
  const allocations = job.job_printer_allocations || [];
  return <div><div className="page-header"><div><div className="page-title">Job Saved</div><div className="page-sub">Receipt generated for {job.client_name}</div></div></div><div className="receipt"><h2>TechCraft Innovator</h2><div className="sub">3D Print Receipt</div><div className="sub">{new Date().toLocaleDateString()} · {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div><hr /><div className="r-row"><span>Client</span><span>{job.client_name}</span></div><div className="r-row"><span>Job Type</span><span>{job.job_type}</span></div>{job.deadline && <div className="r-row"><span>Deadline</span><span>{job.deadline}</span></div>}<hr /><div className="r-row"><span>Filament Used</span><span>{job.total_grams}g</span></div><div className="r-row"><span>Print Time</span><span>{job.total_hours}h</span></div>{job.parts && <div className="r-row"><span>Parts</span><span style={{ maxWidth: 160, textAlign: "right", wordBreak: "break-word" }}>{job.parts}</span></div>}<hr /><div className="r-row"><span>Printers Used</span><span>{allocations.map((p) => p.printers?.name || p.printer_id).join(", ")}</span></div><div className="r-row"><span>Filament</span><span>{job.filaments?.type} {job.filaments?.color}</span></div><hr /><div className="r-total"><span>TOTAL</span><span>{peso(job.charged_total)}</span></div><div className="sub" style={{ marginTop: 12 }}>Job ID: {String(job.id).toUpperCase().slice(0, 8)}</div></div><div style={{ display: "flex", justifyContent: "center", gap: 12, marginTop: 24 }}><button className="btn btn-ghost" onClick={() => window.print()}>Print Receipt</button><button className="btn btn-primary" onClick={onNew}>New Job →</button></div></div>;
}

function JobOrdersView({ jobs, setJobs, reload }) {
  const [filter, setFilter] = useState("all");
  const [msg, setMsg] = useState("");
  const shown = jobs.filter((j) => filter === "all" || j.status === filter);
  const updateJob = async (id, patch) => {
    const previous = jobs;
    setJobs((current) => current.map((j) => (j.id === id ? { ...j, ...patch } : j)));
    const { error } = await supabase.from("jobs").update(patch).eq("id", id);
    if (error) { setJobs(previous); setMsg(error.message); } else { setMsg("Saved."); await reload(); }
  };
  const removeJob = async (id) => {
    if (!confirm("Delete this saved order?")) return;
    const { error } = await supabase.from("jobs").delete().eq("id", id);
    if (error) setMsg(error.message); else await reload();
  };
  return <div><div className="page-header"><div><div className="page-title">Job Orders</div><div className="page-sub">Pulled directly from the <strong>jobs</strong> table. No duplicate add-order workflow.</div></div><button className="btn btn-ghost" onClick={reload}>Refresh</button></div>{msg && <div className="notice">{msg}</div>}<div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>{["all", ...JOB_STATUSES].map((s) => <button key={s} className={`chip ${filter === s ? "selected" : ""}`} onClick={() => setFilter(s)}>{s} {s === "all" ? `(${jobs.length})` : `(${jobs.filter((j) => j.status === s).length})`}</button>)}</div>{shown.length === 0 ? <div className="card" style={{ textAlign: "center", color: T.textMuted }}>No saved jobs found.</div> : <div className="card"><table className="table"><thead><tr><th>Order</th><th>Client</th><th>Filament</th><th>Printers</th><th>Grams / Time</th><th>Total</th><th>Status</th><th>Payment</th><th></th></tr></thead><tbody>{shown.map((j) => <tr key={j.id}><td><div style={{ color: T.text, fontWeight: 600 }}>{j.job_type}</div><div style={{ fontFamily: T.fontMono, fontSize: 11, color: T.textDim }}>{String(j.id).slice(0, 8).toUpperCase()}</div><div style={{ fontSize: 11, color: T.textDim }}>{new Date(j.created_at).toLocaleString()}</div></td><td>{j.client_name}<br />{j.deadline && <span style={{ fontSize: 11, color: T.warn }}>Due {j.deadline}</span>}</td><td>{j.filaments ? `${j.filaments.brand} ${j.filaments.type} ${j.filaments.color}` : "—"}</td><td>{(j.job_printer_allocations || []).map((a) => <div key={a.id || a.printer_id}>{a.printers?.name || a.printer_id} · {a.percentage}%</div>)}</td><td style={{ fontFamily: T.fontMono }}>{j.total_grams}g<br />{j.total_hours}h</td><td style={{ fontFamily: T.fontMono, color: T.text }}>{peso(j.charged_total)}<br /><span style={{ color: T.accent, fontSize: 11 }}>profit {peso(j.profit_total)}</span></td><td><select value={j.status} onChange={(e) => updateJob(j.id, { status: e.target.value })}>{JOB_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select></td><td><select value={j.payment_status} onChange={(e) => updateJob(j.id, { payment_status: e.target.value })}>{PAYMENT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select></td><td><button className="btn btn-danger" style={{ padding: "5px 10px", fontSize: 11 }} onClick={() => removeJob(j.id)}>Delete</button></td></tr>)}</tbody></table></div>}</div>;
}

function InventoryView({ filaments, reload }) {
  const blank = { brand: "", type: "", color: "", finish: "", price_per_kg: "", true_cost_per_kg: "", selling_price_per_kg: "", active: true };
  const [show, setShow] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(blank);
  const [msg, setMsg] = useState("");
  const openAdd = () => { setForm(blank); setEditId(null); setShow(true); setMsg(""); };
  const openEdit = (f) => { setForm({ ...f, price_per_kg: String(f.price_per_kg), true_cost_per_kg: String(f.true_cost_per_kg), selling_price_per_kg: String(f.selling_price_per_kg) }); setEditId(f.id); setShow(true); setMsg(""); };
  const save = async () => {
    if (!form.brand || !form.type || !form.color || !form.finish || !requiredNumber(form.price_per_kg) || !requiredNumber(form.true_cost_per_kg) || !requiredNumber(form.selling_price_per_kg)) { setMsg("Complete all filament fields."); return; }
    const payload = { brand: form.brand, type: form.type, color: form.color, finish: form.finish, price_per_kg: Number(form.price_per_kg), true_cost_per_kg: Number(form.true_cost_per_kg), selling_price_per_kg: Number(form.selling_price_per_kg), active: Boolean(form.active) };
    const { error } = editId ? await supabase.from("filaments").update(payload).eq("id", editId) : await supabase.from("filaments").insert(payload);
    if (error) setMsg(error.message); else { setShow(false); await reload(); }
  };
  const archive = async (id) => { const { error } = await supabase.from("filaments").update({ active: false }).eq("id", id); if (error) setMsg(error.message); else await reload(); };
  return <div><div className="page-header"><div><div className="page-title">Filament Inventory</div><div className="page-sub">Your filament database and required cost/selling values.</div></div><button className="btn btn-primary" onClick={openAdd}>+ Add Filament</button></div>{msg && <div className="validation-gate">{msg}</div>}<div className="card"><table className="table"><thead><tr><th>Filament</th><th>Type</th><th>Finish</th><th>Ref ₱/kg</th><th>True ₱/kg</th><th>Sell ₱/kg</th><th>Status</th><th>Actions</th></tr></thead><tbody>{filaments.map((f) => <tr key={f.id}><td><span className="filament-color-dot" style={{ background: getFilColor(f.color), marginRight: 8 }} />{f.color}<br /><span style={{ fontSize: 11, color: T.textDim }}>{f.brand}</span></td><td><span className="badge badge-info">{f.type}</span></td><td>{f.finish}</td><td>{f.price_per_kg}</td><td>{f.true_cost_per_kg}</td><td>{f.selling_price_per_kg}</td><td><span className={f.active ? "badge badge-accent" : "badge"}>{f.active ? "Active" : "Inactive"}</span></td><td><button className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 11 }} onClick={() => openEdit(f)}>Edit</button> <button className="btn btn-danger" style={{ padding: "5px 10px", fontSize: 11 }} onClick={() => archive(f.id)}>Archive</button></td></tr>)}</tbody></table></div>{show && <EditModal title={editId ? "Edit Filament" : "Add Filament"} onClose={() => setShow(false)} onSave={save}>{["brand", "type", "color", "finish", "price_per_kg", "true_cost_per_kg", "selling_price_per_kg"].map((k) => <div className="input-group" key={k}><label>{k}</label><input type={k.includes("kg") ? "number" : "text"} value={form[k] ?? ""} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} /></div>)}</EditModal>}</div>;
}

function PrintersView({ printerRows, reload }) {
  const blank = { id: "", name: "", brand: "", wattage: "", multicolor: false, build_volume: "", base_rate: "", efficiency: "", labor: "", multiplier: "", active: true };
  const [show, setShow] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(blank);
  const [msg, setMsg] = useState("");
  const openAdd = () => { setForm(blank); setEditId(null); setShow(true); setMsg(""); };
  const openEdit = (p) => { setForm(Object.fromEntries(Object.entries({ ...p }).map(([k, v]) => [k, v ?? ""]))); setEditId(p.id); setShow(true); setMsg(""); };
  const save = async () => {
    if (!form.id || !form.name || !requiredNumber(form.wattage) || !requiredNumber(form.base_rate) || !requiredNumber(form.efficiency) || !requiredNumber(form.labor) || !requiredNumber(form.multiplier)) { setMsg("Complete required printer fields."); return; }
    const payload = { id: form.id, name: form.name, brand: form.brand, wattage: Number(form.wattage), multicolor: Boolean(form.multicolor), build_volume: form.build_volume, base_rate: Number(form.base_rate), efficiency: Number(form.efficiency), labor: Number(form.labor), multiplier: Number(form.multiplier), active: Boolean(form.active) };
    const { error } = editId ? await supabase.from("printers").update(payload).eq("id", editId) : await supabase.from("printers").insert(payload);
    if (error) setMsg(error.message); else { setShow(false); await reload(); }
  };
  return <div><div className="page-header"><div><div className="page-title">Printers</div><div className="page-sub">Edit printer rates used by the cost engine.</div></div><button className="btn btn-primary" onClick={openAdd}>+ Add Printer</button></div>{msg && <div className="validation-gate">{msg}</div>}<div className="card"><table className="table"><thead><tr><th>Printer</th><th>Wattage</th><th>Base Rate</th><th>Efficiency</th><th>Labor</th><th>Multiplier</th><th>Status</th><th></th></tr></thead><tbody>{printerRows.map((p) => <tr key={p.id}><td>{p.name}<br /><span style={{ fontSize: 11, color: T.textDim }}>{p.id} · {p.brand}</span></td><td>{p.wattage}W</td><td>{p.base_rate}</td><td>{p.efficiency}</td><td>{p.labor}</td><td>{p.multiplier}</td><td><span className={p.active ? "badge badge-accent" : "badge"}>{p.active ? "Active" : "Inactive"}</span></td><td><button className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 11 }} onClick={() => openEdit(p)}>Edit</button></td></tr>)}</tbody></table></div>{show && <EditModal title={editId ? "Edit Printer" : "Add Printer"} onClose={() => setShow(false)} onSave={save}>{["id", "name", "brand", "wattage", "build_volume", "base_rate", "efficiency", "labor", "multiplier"].map((k) => <div className="input-group" key={k}><label>{k}</label><input type={["wattage", "base_rate", "efficiency", "labor", "multiplier"].includes(k) ? "number" : "text"} value={form[k] ?? ""} disabled={editId && k === "id"} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} /></div>)}<label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={Boolean(form.multicolor)} onChange={(e) => setForm((f) => ({ ...f, multicolor: e.target.checked }))} style={{ width: "auto" }} /> Multicolor capable</label></EditModal>}</div>;
}

function PricingSettingsView({ pricingConfig, setPricingConfig, reload }) {
  const [draft, setDraft] = useState(pricingConfig || EMPTY_PRICING_CONFIG);
  const [msg, setMsg] = useState("");
  useEffect(() => setDraft(pricingConfig || EMPTY_PRICING_CONFIG), [pricingConfig]);
  const save = async () => {
    if (!requiredNumber(draft.electricity_rate) || !requiredNumber(draft.minimum_price) || !requiredNumber(draft.markup_multiplier) || !draft.formula) { setMsg("Complete all pricing fields."); return; }
    const payload = { id: "default", electricity_rate: Number(draft.electricity_rate), minimum_price: Number(draft.minimum_price), markup_multiplier: Number(draft.markup_multiplier), formula: draft.formula };
    const { data, error } = await supabase.from("pricing_settings").upsert(payload, { onConflict: "id" }).select().single();
    if (error) setMsg(error.message); else { setPricingConfig(data); setMsg("Pricing saved."); await reload(); }
  };
  return <div><div className="page-header"><div><div className="page-title">Pricing Formula</div><div className="page-sub">Admin-only pricing controls. Not shown on customer receipts.</div></div></div>{msg && <div className={msg.includes("saved") ? "notice" : "validation-gate"}>{msg}</div>}<div className="grid2"><div className="card"><div className="card-title"><span className="card-title-dot" />Settings</div><div className="input-group"><label>Formula</label><textarea rows={5} value={draft.formula || ""} onChange={(e) => setDraft((d) => ({ ...d, formula: e.target.value }))} style={{ fontFamily: T.fontMono }} /></div><div className="input-row"><div className="input-group"><label>Electricity Rate / kWh</label><input type="number" value={draft.electricity_rate ?? ""} onChange={(e) => setDraft((d) => ({ ...d, electricity_rate: e.target.value }))} /></div><div className="input-group"><label>Minimum Price</label><input type="number" value={draft.minimum_price ?? ""} onChange={(e) => setDraft((d) => ({ ...d, minimum_price: e.target.value }))} /></div></div><div className="input-group"><label>Markup Multiplier</label><input type="number" value={draft.markup_multiplier ?? ""} onChange={(e) => setDraft((d) => ({ ...d, markup_multiplier: e.target.value }))} /></div><button className="btn btn-primary" onClick={save}>Save Pricing</button></div><div className="card"><div className="card-title"><span className="card-title-dot" />Allowed Variables</div>{["grams", "hours", "filament_real", "filament_charged", "electricity_real", "electricity_charged", "printer_real", "printer_charged", "real_total", "default_charged_total", "machine_rate", "power_kw", "electricity_rate", "printer_multiplier", "efficiency_modifier", "labor_factor", "markup_multiplier", "minimum_price"].map((v) => <span key={v} className="tag" style={{ display: "inline-block", marginBottom: 8, fontFamily: T.fontMono, padding: "6px 9px" }}>{v}</span>)}</div></div></div>;
}

function AnalyticsView({ jobs }) {
  const totalRev = jobs.reduce((s, j) => s + Number(j.charged_total || 0), 0);
  const totalCost = jobs.reduce((s, j) => s + Number(j.real_total || 0), 0);
  const totalProfit = jobs.reduce((s, j) => s + Number(j.profit_total || 0), 0);
  const avgMargin = totalRev > 0 ? (totalProfit / totalRev) * 100 : 0;
  return <div><div className="page-header"><div><div className="page-title">Analytics</div><div className="page-sub">Based on saved jobs from the database.</div></div></div><div className="grid4"><div className="stat-card"><div className="stat-label">Orders</div><div className="stat-val">{jobs.length}</div></div><div className="stat-card"><div className="stat-label">Revenue</div><div className="stat-val">{peso(totalRev)}</div></div><div className="stat-card"><div className="stat-label">Real Cost</div><div className="stat-val">{peso(totalCost)}</div></div><div className="stat-card"><div className="stat-label">Profit</div><div className="stat-val" style={{ color: T.accent }}>{peso(totalProfit)}</div><div className="stat-sub">{pct(avgMargin)} margin</div></div></div></div>;
}

function EditModal({ title, children, onClose, onSave }) {
  return <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}><div className="modal"><h3>{title}</h3>{children}<div style={{ display: "flex", gap: 10, marginTop: 16 }}><button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Cancel</button><button className="btn btn-primary" style={{ flex: 1 }} onClick={onSave}>Save</button></div></div></div>;
}
