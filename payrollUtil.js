'use strict';

const SSS_TABLE = [
  { min:0,      max:3249.99,  ee:135,   er:265   },
  { min:3250,   max:3749.99,  ee:157.5, er:307.5 },
  { min:3750,   max:4249.99,  ee:180,   er:350   },
  { min:4250,   max:4749.99,  ee:202.5, er:392.5 },
  { min:4750,   max:5249.99,  ee:225,   er:437.5 },
  { min:5250,   max:5749.99,  ee:247.5, er:480   },
  { min:5750,   max:6249.99,  ee:270,   er:525   },
  { min:6250,   max:6749.99,  ee:292.5, er:567.5 },
  { min:6750,   max:7249.99,  ee:315,   er:612.5 },
  { min:7250,   max:7749.99,  ee:337.5, er:655   },
  { min:7750,   max:8249.99,  ee:360,   er:700   },
  { min:8250,   max:8749.99,  ee:382.5, er:742.5 },
  { min:8750,   max:9249.99,  ee:405,   er:787.5 },
  { min:9250,   max:9749.99,  ee:427.5, er:830   },
  { min:9750,   max:10249.99, ee:450,   er:875   },
  { min:10250,  max:10749.99, ee:472.5, er:917.5 },
  { min:10750,  max:11249.99, ee:495,   er:962.5 },
  { min:11250,  max:11749.99, ee:517.5, er:1005  },
  { min:11750,  max:12249.99, ee:540,   er:1050  },
  { min:12250,  max:12749.99, ee:562.5, er:1092.5},
  { min:12750,  max:13249.99, ee:585,   er:1137.5},
  { min:13250,  max:13749.99, ee:607.5, er:1180  },
  { min:13750,  max:14249.99, ee:630,   er:1225  },
  { min:14250,  max:14749.99, ee:652.5, er:1267.5},
  { min:14750,  max:15249.99, ee:675,   er:1312.5},
  { min:15250,  max:15749.99, ee:697.5, er:1355  },
  { min:15750,  max:16249.99, ee:720,   er:1400  },
  { min:16250,  max:16749.99, ee:742.5, er:1442.5},
  { min:16750,  max:17249.99, ee:765,   er:1487.5},
  { min:17250,  max:17749.99, ee:787.5, er:1530  },
  { min:17750,  max:18249.99, ee:810,   er:1575  },
  { min:18250,  max:18749.99, ee:832.5, er:1617.5},
  { min:18750,  max:19249.99, ee:855,   er:1662.5},
  { min:19250,  max:19749.99, ee:877.5, er:1705  },
  { min:19750,  max:20249.99, ee:900,   er:1750  },
  { min:20250,  max:Infinity, ee:900,   er:1750  },
];

function computeSSS(monthlyBasic) {
  const row = SSS_TABLE.find(r => monthlyBasic >= r.min && monthlyBasic <= r.max)
           || SSS_TABLE[SSS_TABLE.length - 1];
  return { employee: row.ee, employer: row.er };
}

function computePhilHealth(monthlyBasic) {
  const salary = Math.min(Math.max(monthlyBasic, 10000), 100000);
  const half   = Math.round((salary * 0.05 / 2) * 100) / 100;
  return { employee: half, employer: half };
}

function computePagIbig(monthlyBasic) {
  const ee = Math.min(monthlyBasic * 0.02, 100);
  const er = Math.min(monthlyBasic * 0.02, 100);
  return { employee: ee, employer: er };
}

function computeWithholdingTax(monthlyTaxable) {
  let tax = 0;
  if      (monthlyTaxable <= 20833)  tax = 0;
  else if (monthlyTaxable <= 33332)  tax = (monthlyTaxable - 20833) * 0.20;
  else if (monthlyTaxable <= 66666)  tax = 2500 + (monthlyTaxable - 33333) * 0.25;
  else if (monthlyTaxable <= 166666) tax = 10833.33 + (monthlyTaxable - 66667) * 0.30;
  else if (monthlyTaxable <= 666666) tax = 40833.33 + (monthlyTaxable - 166667) * 0.32;
  else                               tax = 200833.33 + (monthlyTaxable - 666667) * 0.35;
  return Math.round(tax * 100) / 100;
}

function computePayroll(params) {
  const { basicPay, allowances=0, overtimePay=0, daysAbsent=0, latesMinutes=0, workingDays=22 } = params;
  const dailyRate        = basicPay / workingDays;
  const hourlyRate       = dailyRate / 8;
  const absenceDeduction = daysAbsent * dailyRate;
  const lateDeduction    = (latesMinutes / 60) * hourlyRate;
  const adjustedBasic    = basicPay - absenceDeduction - lateDeduction;
  const grossPay         = adjustedBasic + overtimePay + allowances;
  const sss        = computeSSS(basicPay);
  const philhealth = computePhilHealth(basicPay);
  const pagibig    = computePagIbig(basicPay);
  const totalEeDeductions = sss.employee + philhealth.employee + pagibig.employee;
  const taxableIncome     = adjustedBasic + overtimePay - totalEeDeductions;
  const withholdingTax    = computeWithholdingTax(Math.max(0, taxableIncome));
  const totalDeductions   = totalEeDeductions + withholdingTax;
  const netPay            = grossPay - totalDeductions;
  return {
    grossPay:         Math.round(grossPay * 100) / 100,
    absenceDeduction: Math.round(absenceDeduction * 100) / 100,
    lateDeduction:    Math.round(lateDeduction * 100) / 100,
    allowances, overtimePay,
    contributions: { sss, philhealth, pagibig },
    withholdingTax,
    totalDeductions: Math.round(totalDeductions * 100) / 100,
    netPay:          Math.round(netPay * 100) / 100,
  };
}

module.exports = { computePayroll, computeSSS, computePhilHealth, computePagIbig, computeWithholdingTax };
