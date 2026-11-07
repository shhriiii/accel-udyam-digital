// # Deterministic eligibility, dependencies & pricing
import { db } from './dataLoader.js';

// Maps segment display name or shorthand to catalogue target_segments codes
export function mapSegmentCode(segmentInput = '') {
  const s = segmentInput.toLowerCase();
  if (s.includes('micro') || s.includes('kirana') || s.includes('retail') || s.includes('salon') || s.includes('pharmacy')) return 'micro';
  if (s.includes('mfg') || s.includes('manufactur') || s.includes('factory') || s.includes('textile') || s.includes('auto')) return 'mfg';
  if (s.includes('multi') || s.includes('chain') || Number(segmentInput.num_sites) >= 2) return 'multi';
  return 'prof'; // Default to Professional offices (Clinic, CA, Coaching, Travel agency)
}

// Checks if a single product is eligible for a given customer profile
export function checkProductEligibility(product, profile) {
  const reasons = [];
  const cityTier = Number(profile.city_tier || 1);
  const employees = Number(profile.employee_count || 1);
  const sites = Number(profile.num_sites || 1);
  const hasGstin = profile.has_gstin === 'Y' || Boolean(profile.gstin);

  if (!product.available_tiers_list.includes(cityTier)) {
    reasons.push(`Only available in Tier ${product.available_city_tiers} cities`);
  }
  if (employees < product.min_employees) {
    reasons.push(`Requires minimum ${product.min_employees} employees (you have ${employees})`);
  }
  if (sites < product.min_sites) {
    reasons.push(`Requires minimum ${product.min_sites} sites (you have ${sites})`);
  }
  if (product.requires_gstin === 'Y' && !hasGstin) {
    reasons.push(`Requires an Active GSTIN`);
  }

  return {
    eligible: reasons.length === 0,
    reasons
  };
}

// Generates a smart, rule-compliant recommended bundle + eligible add-ons
export function recommendBundle(profile) {
  const segCode = profile.segment_code || mapSegmentCode(profile.segment || profile.business_type || '');
  const employees = Number(profile.employee_count || 5);
  const sites = Number(profile.num_sites || 1);
  const hasGstin = profile.has_gstin === 'Y' || Boolean(profile.gstin);
  const needsText = (profile.needs || '').toLowerCase();

  // 1. Filter all eligible products for this customer
  const eligibleProducts = [];
  const ineligibleProducts = [];

  for (const prod of db.products) {
    const check = checkProductEligibility(prod, { ...profile, has_gstin: hasGstin ? 'Y' : 'N' });
    if (check.eligible) {
      eligibleProducts.push(prod);
    } else {
      ineligibleProducts.push({ product_id: prod.product_id, product_name: prod.product_name, reasons: check.reasons });
    }
  }

  const selectedIds = new Set();

  // 2. Pick Core Connectivity (Every bundle needs primary internet)
  if (segCode === 'mfg' && employees >= 25 && hasGstin) {
    selectedIds.add('P06'); // ILL 100 Mbps
  } else if ((segCode === 'mfg' || segCode === 'multi') && employees >= 10 && hasGstin) {
    selectedIds.add('P05'); // ILL 20 Mbps
  } else if (Number(profile.city_tier) === 1 && employees >= 5 && hasGstin && (segCode === 'prof' || segCode === 'multi')) {
    selectedIds.add('P03'); // Biz Fibre 1G
  } else if (segCode === 'prof' || segCode === 'multi' || employees > 5) {
    selectedIds.add('P02'); // Biz Fibre 300
  } else if (needsText.includes('no fibre') || needsText.includes('wireless') || needsText.includes('5g')) {
    selectedIds.add('P04'); // Biz 5G AirFiber 100
  } else {
    selectedIds.add('P01'); // Biz Fibre 100
  }

  // 3. Pick Mobile Lines
  if (segCode === 'micro') {
    selectedIds.add('P07'); // Business Postpaid 299
  } else {
    selectedIds.add('P08'); // Business Postpaid 599
  }

  // 4. Segment & Intent Specific Additions
  if (segCode === 'micro') {
    if (hasGstin && (needsText.includes('whatsapp') || needsText.includes('catalogue') || needsText.includes('promo') || !needsText)) {
      selectedIds.add('P15'); // WhatsApp Business API Starter
    }
    if (needsText.includes('pos') || needsText.includes('billing') || needsText.includes('upi') || needsText.includes('shop') || needsText.includes('kirana')) {
      selectedIds.add('P19'); // Cloud POS & Billing
    }
    if (needsText.includes('cctv') || needsText.includes('camera') || needsText.includes('security')) {
      selectedIds.add('P23'); // Cloud CCTV
    }
  } else if (segCode === 'prof') {
    selectedIds.add('P16'); // Cloud Email & Office Suite
    selectedIds.add('P20'); // Endpoint Security
    if (hasGstin && employees >= 3 && (needsText.includes('call') || needsText.includes('ivr') || needsText.includes('phone') || needsText.includes('telephony'))) {
      selectedIds.add('P12'); // Cloud Telephony / SIP
    }
    if (needsText.includes('backup') || needsText.includes('storage')) {
      selectedIds.add('P17'); // Cloud Backup 1 TB
    }
  } else if (segCode === 'multi') {
    selectedIds.add('P09'); // Backup 4G/5G Failover
    selectedIds.add('P23'); // Cloud CCTV
    if (sites >= 3 && employees >= 10 && hasGstin) {
      selectedIds.add('P10'); // Managed SD-WAN
    }
    if (hasGstin) {
      selectedIds.add('P15'); // WhatsApp Business API
    }
  } else if (segCode === 'mfg') {
    selectedIds.add('P20'); // Endpoint Security
    selectedIds.add('P23'); // Cloud CCTV
    if (employees >= 10 && hasGstin) {
      selectedIds.add('P21'); // Managed Firewall
      selectedIds.add('P24'); // Machine Monitoring IoT
    }
  }

  // 5. Explicit Keyword Overrides from User Chat
  const keywordToProduct = [
    { kw: ['whatsapp'], id: 'P15' },
    { kw: ['sms', 'alerts'], id: 'P14' },
    { kw: ['toll-free', '1800', 'toll free'], id: 'P13' },
    { kw: ['ivr', 'sip', 'cloud telephony'], id: 'P12' },
    { kw: ['website', 'domain'], id: 'P18' },
    { kw: ['pos', 'billing'], id: 'P19' },
    { kw: ['cctv', 'camera'], id: 'P23' },
    { kw: ['wifi', 'wi-fi', 'guest'], id: 'P22' },
    { kw: ['firewall'], id: 'P21' },
    { kw: ['sd-wan', 'sdwan'], id: 'P10' },
    { kw: ['failover', 'backup internet'], id: 'P09' },
    { kw: ['static ip'], id: 'P11' },
    { kw: ['fleet', 'gps', 'vehicle'], id: 'P25' },
    { kw: ['iot', 'machine'], id: 'P24' }
  ];

  for (const rule of keywordToProduct) {
    if (rule.kw.some(k => needsText.includes(k))) {
      selectedIds.add(rule.id);
    }
  }

  // 6. Enforce Eligibility & Dependency Rules (`requires_one_of`)
  const eligibleIdSet = new Set(eligibleProducts.map(p => p.product_id));
  for (const id of Array.from(selectedIds)) {
    if (!eligibleIdSet.has(id)) {
      selectedIds.delete(id);
      continue;
    }
    const prod = eligibleProducts.find(p => p.product_id === id);
    if (prod.dependencies.length > 0) {
      const hasDep = prod.dependencies.some(depId => selectedIds.has(depId));
      if (!hasDep) {
        // Automatically add the first eligible dependency or remove the item
        const fallbackDep = prod.dependencies.find(depId => eligibleIdSet.has(depId));
        if (fallbackDep) selectedIds.add(fallbackDep);
        else selectedIds.delete(id);
      }
    }
  }

  // 7. Calculate Quantities & Transparent Pricing
  const formatProductItem = (prod, isRecommended) => {
    let qty = 1;
    if (prod.unit === 'per site') qty = sites;
    else if (prod.unit === 'per line') qty = Math.min(employees, Math.max(2, Math.ceil(employees * 0.5)));
    else if (prod.unit === 'per user' || prod.unit === 'per device') qty = Math.max(2, Math.ceil(employees * 0.6));
    else if (prod.unit === 'per camera') qty = sites * 2;
    else if (prod.unit === 'per counter') qty = sites;

    // Use price_min_inr_per_month as standard bundle price
    const unitPrice = prod.price_min_inr_per_month;
    return {
      ...prod,
      quantity: qty,
      unit_price_inr: unitPrice,
      monthly_total_inr: unitPrice * qty,
      recommended: isRecommended
    };
  };

  const recommendedItems = [];
  const availableAddons = [];

  for (const prod of eligibleProducts) {
    if (selectedIds.has(prod.product_id)) {
      recommendedItems.push(formatProductItem(prod, true));
    } else {
      availableAddons.push(formatProductItem(prod, false));
    }
  }

  const totalMonthly = recommendedItems.reduce((sum, item) => sum + item.monthly_total_inr, 0);
  const totalSetup = recommendedItems.reduce((sum, item) => sum + item.one_time_setup_inr, 0);
  const maxInstallDays = recommendedItems.reduce((max, item) => Math.max(max, item.typical_install_days), 2);
  const maxContractMonths = recommendedItems.reduce((max, item) => Math.max(max, item.min_contract_months), 12);

  return {
    segment_code: segCode,
    recommended_items: recommendedItems,
    available_addons: availableAddons,
    ineligible_items: ineligibleProducts,
    summary: {
      monthly_total_inr: totalMonthly,
      one_time_setup_inr: totalSetup,
      contract_months: maxContractMonths,
      estimated_install_days: maxInstallDays,
      gst_18_percent_inr: Math.round(totalMonthly * 0.18),
      grand_monthly_total_inr: Math.round(totalMonthly * 1.18)
    }
  };
}