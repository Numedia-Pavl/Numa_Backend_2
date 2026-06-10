/**
 * NUMA HRIS – Philippine Payroll Engine
 * Last updated: 2024
 *
 * Sources:
 *  - SSS   : Circular No. 2023-010 (14% rate, effective Jan 2024)
 *  - PhilHealth: PhilHealth Advisory (5% rate, ₱10K–₱100K base)
 *  - Pag-IBIG: RA 9679 (2% employee, capped at ₱100/mo)
 *  - Income Tax: TRAIN Law RA 10963 – 2023+ brackets
 */

// ─── SSS 2024 ────────────────────────────────────────────────
// Rate: 14% total | Employee: 4.5% | Employer: 9.5% (includes EC)
// MSC range: ₱4,000 – ₱30,000 in ₱500 steps
const SSS_EE_RATE  = 0.045;
const SSS_ER_RATE  = 0.095;

function getSSSMSC(basicSalary) {
  if (basicSalary < 4250)  return 4000;
  if (basicSalary >= 29750) return 30000;
  // Compute MSC: nearest ₱500 below compensation midpoints
  // Midpoint for MSC X is X + 250; so MSC = floor((salary - 4000) / 500) * 500 + 4000
  // Simplified: round salary to nearest lower ₱500 step in range
  const step  = Math.floor((basicSalary - 4250) / 500);
  const msc   = 4500 + step * 500;
  return Math.min(msc, 30000);
}

function computeSSS(basicSalary) {
  const msc      = getSSSMSC(basicSalary);
  const employee = round2(msc * SSS_EE_RATE);
  const employer = round2(msc * SSS_ER_RATE);
  return { employee, employer, msc };
}

// ─── PHILHEALTH 2024 ─────────────────────────────────────────
// Rate: 5% total | Employee 2.5% | Employer 2.5%
// Floor: ₱10,000 basic (₱250 EE) | Ceiling: ₱100,000 basic (₱2,500 EE)
const PH_RATE    = 0.05;
const PH_FLOOR   = 10000;
const PH_CEILING = 100000;

function computePhilHealth(basicSalary) {
  const base     = clamp(basicSalary, PH_FLOOR, PH_CEILING);
  const total    = round2(base * PH_RATE);
  const employee = round2(total / 2);
  const employer = round2(total - employee);
  return { employee, employer, total };
}

// ─── PAG-IBIG 2024 ───────────────────────────────────────────
// Employee: 1% if salary ≤ ₱1,500; 2% if > ₱1,500 (max ₱100/mo)
// Employer: 2% (min ₱100/mo)
// Computed on max compensation base of ₱5,000
const PAGIBIG_MAX_BASE = 5000;
const PAGIBIG_MAX_EE   = 100;

function computePagIBIG(basicSalary) {
  const rate     = basicSalary <= 1500 ? 0.01 : 0.02;
  const base     = Math.min(basicSalary, PAGIBIG_MAX_BASE);
  const employee = Math.min(round2(base * rate),  PAGIBIG_MAX_EE);
  const employer = Math.min(round2(base * 0.02),  PAGIBIG_MAX_EE);
  return { employee, employer };
}

// ─── WITHHOLDING TAX (TRAIN Law 2023+) ───────────────────────
// Monthly taxable income = Gross - (SSS + PhilHealth + Pag-IBIG) employee shares
//
// Annual brackets (÷12 for monthly):
//   ₱0 – ₱250,000/yr  (₱0 – ₱20,833/mo)    → 0%
//   ₱250,001 – ₱400,000  (₱20,834 – ₱33,333) → 15% of excess over ₱20,833
//   ₱400,001 – ₱800,000  (₱33,334 – ₱66,667) → ₱1,875 + 20% of excess over ₱33,333
//   ₱800,001 – ₱2M       (₱66,668 – ₱166,667)→ ₱8,541.67 + 25% of excess over ₱66,667
//   ₱2M+1 – ₱8M          (₱166,668 – ₱666,667)→ ₱33,541.67 + 30% of excess over ₱166,667
//   Over ₱8M              (over ₱666,667)      → ₱183,541.67 + 35% of excess over ₱666,667

function computeWithholdingTax(taxableMonthly) {
  if (taxableMonthly <= 0)      return 0;
  if (taxableMonthly <= 20833)  return 0;
  if (taxableMonthly <= 33333)  return round2((taxableMonthly - 20833) * 0.15);
  if (taxableMonthly <= 66667)  return round2(1875 + (taxableMonthly - 33333) * 0.20);
  if (taxableMonthly <= 166667) return round2(8541.67 + (taxableMonthly - 66667) * 0.25);
  if (taxableMonthly <= 666667) return round2(33541.67 + (taxableMonthly - 166667) * 0.30);
  return round2(183541.67 + (taxableMonthly - 666667) * 0.35);
}

// ─── MAIN COMPUTE FUNCTION ───────────────────────────────────
/**
 * computePayroll(data)
 *
 * @param {Object} data
 *   basic_salary          {number}  Required. Monthly basic salary
 *   overtime_hours        {number}  Default 0. Regular OT hours (1.25×)
 *   holiday_hours         {number}  Default 0. Holiday OT hours (2.6×)
 *   late_minutes          {number}  Default 0. Minutes late
 *   absent_days           {number}  Default 0. Days absent (no pay)
 *   allowances            {number}  Default 0. Non-taxable allowances
 *   other_deductions      {number}  Default 0. Loan repayments, etc.
 *   working_days_per_month{number}  Default 22
 *
 * @returns {Object}  Full payroll breakdown
 */
function computePayroll(data) {
  const {
    basic_salary,
    overtime_hours        = 0,
    holiday_hours         = 0,
    late_minutes          = 0,
    absent_days           = 0,
    allowances            = 0,
    other_deductions      = 0,
    working_days_per_month = 22
  } = data;

  if (!basic_salary || basic_salary <= 0) {
    throw new Error('basic_salary must be a positive number');
  }

  const daily_rate   = round2(basic_salary / working_days_per_month);
  const hourly_rate  = round2(daily_rate / 8);

  // Pay components
  const overtime_pay  = round2(overtime_hours  * hourly_rate * 1.25);
  const holiday_pay   = round2(holiday_hours   * hourly_rate * 2.60);
  const late_deduct   = round2((late_minutes / 60) * hourly_rate);
  const absent_deduct = round2(absent_days * daily_rate);

  // Gross (allowances are separate – non-taxable for most cases)
  const gross_pay = round2(
    basic_salary + overtime_pay + holiday_pay - late_deduct - absent_deduct
  );

  // Government contributions (based on basic salary only)
  const sss       = computeSSS(basic_salary);
  const philhealth = computePhilHealth(basic_salary);
  const pagibig   = computePagIBIG(basic_salary);

  // Taxable income = gross (excl. allowances) minus mandatory deductions
  const mandatory_ee = round2(sss.employee + philhealth.employee + pagibig.employee);
  const taxable_income = Math.max(0, round2(gross_pay - mandatory_ee));

  // Income tax
  const withholding_tax = computeWithholdingTax(taxable_income);

  // Total deductions & net
  const total_deductions = round2(mandatory_ee + withholding_tax + other_deductions);
  const net_pay          = round2(gross_pay + allowances - total_deductions);

  return {
    // Inputs
    basic_salary,
    working_days_per_month,
    daily_rate,
    hourly_rate,

    // Pay components
    overtime_pay,
    holiday_pay,
    allowances,
    gross_pay,

    // Deductions (employee share)
    late_deduction    : late_deduct,
    absent_deduction  : absent_deduct,
    sss_employee      : sss.employee,
    philhealth_employee: philhealth.employee,
    pagibig_employee  : pagibig.employee,
    withholding_tax,
    other_deductions,
    total_deductions,

    // Employer cost (for cost-of-employment report)
    sss_employer        : sss.employer,
    philhealth_employer : philhealth.employer,
    pagibig_employer    : pagibig.employer,
    sss_msc             : sss.msc,

    // Net pay
    net_pay,

    // Computed inputs logged for audit
    taxable_income,
    mandatory_deductions: mandatory_ee,
  };
}

// ─── HELPERS ─────────────────────────────────────────────────
function round2(n)             { return Math.round((n || 0) * 100) / 100; }
function clamp(v, min, max)    { return Math.max(min, Math.min(max, v)); }

module.exports = {
  computePayroll,
  computeSSS,
  computePhilHealth,
  computePagIBIG,
  computeWithholdingTax,
};
