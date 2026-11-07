import { db } from './dataLoader.js';

// Hackathon README explicitly states: Use 2026-07-15 as "today" for any date-based check
export const HACKATHON_TODAY = new Date('2026-07-15T00:00:00Z');

export function computeGstinChecksum(first14 = '') {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let factor = 2;
  let sum = 0;
  for (let i = 13; i >= 0; i--) {
    const codePoint = chars.indexOf(first14[i]);
    if (codePoint === -1) return null;
    let digit = factor * codePoint;
    factor = factor === 2 ? 1 : 2;
    digit = Math.floor(digit / 36) + (digit % 36);
    sum += digit;
  }
  const checkCodePoint = (36 - (sum % 36)) % 36;
  return chars[checkCodePoint];
}

// Fixes OCR font/watermark confusions (like '0' vs 'O' in K02, 'I' vs 'J' in K10, '7' vs 'Z' in K05)
// WITHOUT masking real digit tampering like '8' vs '5' in K06!
export function normalizeOcrGstin(rawGstin = '') {
  if (!rawGstin || typeof rawGstin !== 'string') return '';
  let clean = rawGstin.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (clean.length !== 15) return clean;

  if (db.gstinMap.has(clean)) return clean;

  const digitToLetter = { '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '8': 'B', '7': 'Z' };
  const letterToDigit = { 'O': '0', 'Q': '0', 'D': '0', 'I': '1', 'L': '1', 'Z': '2', 'S': '5', 'B': '8' };

  const chars = clean.split('');
  [0, 1].forEach(i => { if (letterToDigit[chars[i]]) chars[i] = letterToDigit[chars[i]]; });
  [2, 3, 4, 5, 6].forEach(i => { if (digitToLetter[chars[i]]) chars[i] = digitToLetter[chars[i]]; });
  [7, 8, 9, 10].forEach(i => { if (letterToDigit[chars[i]]) chars[i] = letterToDigit[chars[i]]; });
  if (digitToLetter[chars[11]]) chars[11] = digitToLetter[chars[11]];
  if (chars[13] === '7' || chars[13] === '2') chars[13] = 'Z';

  const candidate = chars.join('');
  if (db.gstinMap.has(candidate)) return candidate;

  // Check if an OCR letter confusion in the PAN letters (indices 2..6, like I vs J in K10) matches a registry record with the exact same digits (7..10)
// Only repair an OCR letter misread in PAN letters (indices 2..6) if the State Code (0..2),
  // the 4 PAN digits (7..14), AND the final Checksum character (14) match!
  for (const regGstin of db.gstinMap.keys()) {
    if (
      regGstin.slice(0, 2) === candidate.slice(0, 2) &&
      regGstin.slice(7, 15) === candidate.slice(7, 15)
    ) {
      return regGstin;
    }
  }

  return candidate;
}

export function normalizeOcrUdyam(rawUdyam = '') {
  if (!rawUdyam || typeof rawUdyam !== 'string') return '';
  let clean = rawUdyam.trim().toUpperCase();
  if (clean.startsWith('DYAM-') || clean.startsWith('OYAM-') || clean.startsWith('JDYAM-')) {
    clean = 'UDYAM-' + clean.replace(/^[A-Z]+-/, '');
  }
  const match = clean.match(/UDYAM-[A-Z0-9]{2}-[A-Z0-9]{2}-[A-Z0-9]{7}/);
  if (!match) return clean;

  let parts = match[0].split('-');
  const letterToDigit = { 'O': '0', 'Q': '0', 'I': '1', 'L': '1', 'Z': '2', 'S': '5', 'B': '8' };
  parts[2] = parts[2].split('').map(c => letterToDigit[c] || c).join('');
  parts[3] = parts[3].split('').map(c => letterToDigit[c] || c).join('');
  return parts.join('-');
}

export function validateGstinFormat(gstin) {
  if (!gstin || typeof gstin !== 'string') {
    return { valid: false, reason: 'GSTIN is missing or empty' };
  }
  const clean = normalizeOcrGstin(gstin);
  const regex = /^[0-9]{2}[A-Z]{3}[ABCFGHLJPTKX][A-Z][0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
  if (!regex.test(clean)) {
    return { valid: false, reason: `Invalid 15-character GSTIN structure (${clean})` };
  }

  const expectedChecksum = computeGstinChecksum(clean.slice(0, 14));
  if (clean[14] !== expectedChecksum) {
    return {
      valid: false,
      checksum_failed: true,
      normalized: clean,
      reason: `GSTIN Mod-36 checksum mismatch on "${clean}" (expected '${expectedChecksum}', found '${clean[14]}')`
    };
  }

  return { valid: true, normalized: clean };
}

export function validateUdyamFormat(udyam) {
  if (!udyam || typeof udyam !== 'string' || udyam.trim() === '') {
    return { valid: false, reason: 'Udyam Registration Number is missing on certificate' };
  }
  const clean = normalizeOcrUdyam(udyam);
  const regex = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;
  if (!regex.test(clean)) {
    return { valid: false, reason: `Invalid Udyam number format (${clean})` };
  }
  return { valid: true, normalized: clean };
}

export function maskIdentifier(id = '') {
  if (!id || id.length < 6) return id;
  return id.slice(0, 4) + '•'.repeat(Math.max(4, id.length - 7)) + id.slice(-3);
}

function normalizeEntityName(name = '') {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(pvt|private|ltd|limited|llp|prop|proprietorship)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function runForensicKycValidation(extractedDocs, missingDocTypes = [], haltedPreFlight = false) {
  const checks = [];
  const flags = [];

  // 0. Pre-Flight Missing Document Check (e.g. K05 missing Udyam Certificate)
  if (missingDocTypes.length > 0) {
    for (const missingType of missingDocTypes) {
      flags.push({
        severity: 'CRITICAL',
        field: 'Missing Mandatory Document',
        message: `Required KYC document "${missingType}" is missing from the upload pack (${4 - missingDocTypes.length}/4 documents provided).`
      });
      checks.push({
        label: `Mandatory Doc: ${missingType}`,
        status: 'FAIL',
        detail: 'Missing from applicant pack'
      });
    }

    if (haltedPreFlight) {
      return {
        overall_status: 'ACTION_REQUIRED',
        reference_date: '2026-07-15',
        critical_issues_count: flags.length,
        checks,
        flags
      };
    }
  }

  const gstDoc = extractedDocs?.gst_certificate || {};
  const udyamDoc = extractedDocs?.udyam_certificate || {};
  const idDoc = extractedDocs?.signatory_id || {};
  const addrDoc = extractedDocs?.address_proof || {};

  if (gstDoc.gstin) gstDoc.gstin = normalizeOcrGstin(gstDoc.gstin);
  if (udyamDoc.udyam_number) udyamDoc.udyam_number = normalizeOcrUdyam(udyamDoc.udyam_number);

  // 1. GSTIN Validation & Registry Lookup
  if (gstDoc.gstin) {
    const formatCheck = validateGstinFormat(gstDoc.gstin);
    const regRecord = db.gstinMap.get(gstDoc.gstin);

    if (!formatCheck.valid) {
      let tamperHint = '';
      for (const [regGstin, row] of db.gstinMap.entries()) {
        if (regGstin.slice(0, 7) === gstDoc.gstin.slice(0, 7) && regGstin.slice(11) === gstDoc.gstin.slice(11)) {
          tamperHint = ` — Tampered digit detected! Official Registry GSTIN for ${row.legal_name} is ${regGstin}`;
          break;
        }
      }
      flags.push({
        severity: 'CRITICAL',
        field: 'GSTIN Format & Checksum',
        message: `${formatCheck.reason}${tamperHint}`
      });
      checks.push({ label: 'GSTIN Format & Checksum', status: 'FAIL', detail: formatCheck.reason });
    } else {
      checks.push({ label: 'GSTIN Format & Checksum', status: 'PASS', detail: `Valid Mod-36 checksum (${maskIdentifier(gstDoc.gstin)})` });
    }

    if (!regRecord) {
      flags.push({ severity: 'CRITICAL', field: 'GSTIN Registry', message: `GSTIN ${gstDoc.gstin} not found in Mock GST Registry` });
      checks.push({ label: 'GSTN Portal Live Status', status: 'FAIL', detail: 'Not found in GST Registry' });
    } else if (regRecord.status !== 'Active') {
      flags.push({ severity: 'CRITICAL', field: 'GSTIN Status', message: `GSTIN ${gstDoc.gstin} status is "${regRecord.status}" in GST Registry (Active required)` });
      checks.push({ label: 'GSTN Portal Live Status', status: 'FAIL', detail: `Status is ${regRecord.status.toUpperCase()}` });
    } else {
      checks.push({ label: 'GSTN Portal Live Status', status: 'PASS', detail: `Active (${regRecord.trade_name})` });

      // Check for K07 Trap: Legal Name on Certificate says "(Prop. Shri Physio Clinic)" while Registry & Trade Name say "Neelgiri Physio Clinic"!
      const propMatch = (gstDoc.legal_name || '').match(/\(Prop\.\s*([^)]+)\)/i);
      if (propMatch && gstDoc.trade_name) {
        const propEntity = normalizeEntityName(propMatch[1]);
        const tradeEntity = normalizeEntityName(gstDoc.trade_name);
        if (propEntity && tradeEntity && propEntity.split(' ')[0] !== tradeEntity.split(' ')[0]) {
          flags.push({
            severity: 'CRITICAL',
            field: 'Cross-Document Name Mismatch',
            message: `GST Certificate Legal Name lists proprietorship "${propMatch[1].trim()}", which does not match Trade Name "${gstDoc.trade_name}" and official GST Registry ("${regRecord.legal_name}").`
          });
        }
      }
    }
  } else if (!missingDocTypes.includes('GST Registration Certificate')) {
    flags.push({ severity: 'CRITICAL', field: 'GST Certificate', message: 'No GSTIN found on GST Certificate' });
    checks.push({ label: 'GSTIN Format & Checksum', status: 'FAIL', detail: 'GSTIN missing or unreadable' });
  }

  // 2. Udyam Validation & Registry Lookup
  if (udyamDoc.present && !missingDocTypes.includes('Udyam Registration Certificate')) {
    const uFormat = validateUdyamFormat(udyamDoc.udyam_number);
    if (!uFormat.valid) {
      flags.push({ severity: 'CRITICAL', field: 'Udyam Certificate', message: uFormat.reason });
      checks.push({ label: 'Udyam Registration Check', status: 'FAIL', detail: uFormat.reason });
    } else {
      const uRecord = db.udyamMap.get(udyamDoc.udyam_number);
      if (!uRecord) {
        flags.push({ severity: 'CRITICAL', field: 'Udyam Registry', message: `Udyam ${udyamDoc.udyam_number} not found in MSME Registry` });
        checks.push({ label: 'Udyam Registration Check', status: 'FAIL', detail: 'Not found in MSME Registry' });
      } else {
        checks.push({ label: 'Udyam Registration Check', status: 'PASS', detail: `Verified (${uRecord.enterprise_type} - ${uRecord.major_activity})` });
      }
    }
  }

  // 3. Signatory Authority & ID Expiry Check (Catches Office admin on K01, K08, K09)
  if (idDoc.name || idDoc.designation) {
    const role = (idDoc.designation || '').toLowerCase();
    const unauthorizedRoles = ['office admin', 'receptionist', 'clerk', 'intern', 'assistant', 'staff'];
    const isUnauthorized = unauthorizedRoles.some(r => role.includes(r));

    if (isUnauthorized) {
      flags.push({
        severity: 'CRITICAL',
        field: 'Signatory Authority',
        message: `Signatory "${idDoc.name}" holds designation "${idDoc.designation}" — not an Authorised Signatory / Proprietor / Partner / Director.`
      });
      checks.push({ label: 'Authorised Signatory Role', status: 'FAIL', detail: `Invalid role: ${idDoc.designation}` });
    } else {
      const roleNote =
        role.includes('manager') && (gstDoc.legal_name || '').toLowerCase().includes((idDoc.name || '').toLowerCase().split(' ')[0])
          ? `${idDoc.name} (Manager on ID • Verified Prop. on GST)`
          : `${idDoc.name} (${idDoc.designation})`;
      checks.push({ label: 'Authorised Signatory Role', status: 'PASS', detail: roleNote });
    }

    if (idDoc.valid_till) {
      const expiryDate = new Date(idDoc.valid_till);
      if (expiryDate < HACKATHON_TODAY) {
        flags.push({
          severity: 'CRITICAL',
          field: 'Signatory ID Expiry',
          message: `Signatory ID expired on ${idDoc.valid_till} (Reference date: 2026-07-15)`
        });
        checks.push({ label: 'Signatory ID Validity', status: 'FAIL', detail: `Expired on ${idDoc.valid_till}` });
      } else {
        checks.push({ label: 'Signatory ID Validity', status: 'PASS', detail: `Valid till ${idDoc.valid_till}` });
      }
    }
  }

  // 4. Address Proof 90-Day Recency Check (Catches K11: 2025-10-31 is 257 days old!)
  if (addrDoc.bill_date) {
    const billDate = new Date(addrDoc.bill_date);
    const diffDays = Math.floor((HACKATHON_TODAY - billDate) / (1000 * 60 * 60 * 24));
    if (diffDays > 90) {
      flags.push({
        severity: 'CRITICAL',
        field: 'Address Proof Recency',
        message: `Utility bill dated ${addrDoc.bill_date} is ${diffDays} days old (Exceeds 90-day limit from 2026-07-15)`
      });
      checks.push({ label: 'Address Proof (< 90 Days)', status: 'FAIL', detail: `${diffDays} days old (${addrDoc.bill_date})` });
    } else {
      checks.push({ label: 'Address Proof (< 90 Days)', status: 'PASS', detail: `${diffDays} days old (Bill date: ${addrDoc.bill_date})` });
    }
  }

  // 5. Cross-Document Entity Name & Address Consistency
  const rawNames = [gstDoc.trade_name, udyamDoc.enterprise_name, idDoc.for_business, addrDoc.billed_to].filter(Boolean);
  const cleanNames = rawNames.map(normalizeEntityName).filter(Boolean);

  const hasNameFlagAlready = flags.some(f => f.field === 'Cross-Document Name Mismatch');
  if (cleanNames.length >= 2 && !hasNameFlagAlready) {
    const firstWords = cleanNames[0].split(' ').slice(0, 2).join(' ');
    const mismatch = cleanNames.some(n => !n.includes(cleanNames[0].split(' ')[0]) && !cleanNames[0].includes(n.split(' ')[0]));
    if (mismatch) {
      flags.push({
        severity: 'CRITICAL',
        field: 'Cross-Document Name Mismatch',
        message: `Business names do not match across documents: ${rawNames.join(' vs ')}`
      });
      checks.push({ label: 'Cross-Doc Entity Name Match', status: 'FAIL', detail: 'Entity name mismatch across uploaded proofs' });
    } else {
      checks.push({ label: 'Cross-Doc Entity Name Match', status: 'PASS', detail: `Consistent across ${cleanNames.length} documents (${firstWords})` });
    }
  } else if (hasNameFlagAlready) {
    checks.push({ label: 'Cross-Doc Entity Name Match', status: 'FAIL', detail: 'Legal Name vs Trade Name mismatch on GST Cert' });
  }

  // 6. Cross-Document Pincode Check (Catches K12: 762077 on GST vs 762071 on Utility Bill!)
  if (gstDoc.address && addrDoc.supply_address) {
    const pinGst = (gstDoc.address.match(/\b\d{6}\b/) || [])[0];
    const pinAddr = (addrDoc.supply_address.match(/\b\d{6}\b/) || [])[0];
    if (pinGst && pinAddr && pinGst !== pinAddr) {
      flags.push({
        severity: 'CRITICAL',
        field: 'Address / Pincode Mismatch',
        message: `GST Certificate pincode (${pinGst}) does not match Utility Bill pincode (${pinAddr})`
      });
      checks.push({ label: 'Cross-Doc Address & PIN Match', status: 'FAIL', detail: `PIN ${pinGst} vs ${pinAddr}` });
    } else {
      checks.push({ label: 'Cross-Doc Address & PIN Match', status: 'PASS', detail: `Verified (${pinGst || 'Address matched'})` });
    }
  }

  const criticalCount = flags.filter(f => f.severity === 'CRITICAL').length;

  return {
    overall_status: criticalCount === 0 ? 'APPROVED' : 'ACTION_REQUIRED',
    reference_date: '2026-07-15',
    critical_issues_count: criticalCount,
    checks,
    flags
  };
}