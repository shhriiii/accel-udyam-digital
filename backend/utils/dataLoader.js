// Loads CSVs into memory & indexes GSTIN/Udyam
import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';

export const db = {
  products: [],
  leads: [],
  gstinMap: new Map(),
  udyamMap: new Map(),
  orders: [] // Stores newly created orders during live demo
};

function readCSV(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    if (!fs.existsSync(filePath)) {
      console.warn(`⚠️ Warning: File not found at ${filePath}`);
      return resolve([]);
    }
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', (err) => reject(err));
  });
}

// Propensity Score Model (0-100) based on actual dataset conversion signals
export function calculatePropensityScore(lead) {
  let score = 20; // Base score
  
  // Signal 1: GSTIN presence (9.6% vs 2.0% activation in dataset -> huge signal)
  if (lead.has_gstin === 'Y') score += 30;
  if (lead.has_udyam === 'Y') score += 10;

  // Signal 2: Segment conversion rates (Mfg 12.8%, Prof 11.1%, Multi 11.0% vs Micro 4.0%)
  if (lead.segment === 'Small manufacturers') score += 18;
  else if (lead.segment === 'Professional offices') score += 15;
  else if (lead.segment === 'Small multi-site businesses') score += 15;
  else score += 5;

  // Signal 3: Funnel depth reached before drop
  const stageWeights = {
    'KYC complete': 20,
    'Quote accepted': 15,
    'Needs assessed': 10,
    'Contacted': 5,
    'Lead': 0
  };
  score += stageWeights[lead.stage_reached] || 0;

  // Signal 4: Recoverable Drop Reasons (High intent, operational friction)
  const highRecoverableReasons = [
    'Quote took too long to arrive',
    'Quote too complex to understand',
    'Found paperwork too long',
    'Visit not scheduled by sales',
    'Owner had no time for a visit',
    'Installation delayed beyond 21 days'
  ];
  if (highRecoverableReasons.includes(lead.drop_reason)) {
    score += 12;
  }

  return Math.min(99, Math.max(5, score));
}

export async function loadAllData() {
  const dataDir = path.join(process.cwd(), 'data');

  const rawProducts = await readCSV(path.join(dataDir, 'product_catalogue.csv'));
  db.products = rawProducts.map(p => ({
    ...p,
    price_min_inr_per_month: Number(p.price_min_inr_per_month),
    price_max_inr_per_month: Number(p.price_max_inr_per_month),
    one_time_setup_inr: Number(p.one_time_setup_inr),
    min_contract_months: Number(p.min_contract_months),
    min_employees: Number(p.min_employees),
    min_sites: Number(p.min_sites),
    typical_install_days: Number(p.typical_install_days),
    available_tiers_list: p.available_city_tiers ? p.available_city_tiers.split(';').map(Number) : [1, 2],
    dependencies: p.requires_one_of ? p.requires_one_of.split('|').filter(Boolean) : [],
    segments_list: p.target_segments ? p.target_segments.split(';') : []
  }));

  const rawGstin = await readCSV(path.join(dataDir, 'mock_gstin_registry.csv'));
  rawGstin.forEach(row => {
    db.gstinMap.set(row.gstin.trim().toUpperCase(), row);
  });

  const rawUdyam = await readCSV(path.join(dataDir, 'mock_udyam_registry.csv'));
  rawUdyam.forEach(row => {
    db.udyamMap.set(row.udyam_number.trim().toUpperCase(), row);
  });

  const rawLeads = await readCSV(path.join(dataDir, 'smb_leads.csv'));
  db.leads = rawLeads.map(l => ({
    ...l,
    employee_count: Number(l.employee_count),
    num_sites: Number(l.num_sites),
    city_tier: Number(l.city_tier),
    monthly_telecom_spend_inr: Number(l.monthly_telecom_spend_inr || 0),
    acquisition_cost_inr: Number(l.acquisition_cost_inr || 0),
    propensity_score: calculatePropensityScore(l)
  }));

  console.log(` Loaded ${db.products.length} products, ${db.gstinMap.size} GSTINs, ${db.udyamMap.size} Udyam records, ${db.leads.length} leads.`);
}