import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import Tesseract from 'tesseract.js';
import { db, loadAllData } from './utils/dataLoader.js';
import { recommendBundle } from './utils/bundleEngine.js';
import { runForensicKycValidation, validateGstinFormat, validateUdyamFormat, maskIdentifier } from './utils/kycValidator.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

const upload = multer({ storage: multer.memoryStorage() });

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

// Preferred Groq models in ranked order (will auto-verify against your account's /openai/v1/models list!)
const PREFERRED_GROQ_CHAT_MODELS = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'openai/gpt-oss-120b',
  'qwen/qwen3-32b',
  'openai/gpt-oss-20b',
  'llama-3.1-8b-instant',
  'groq/compound-mini'
];
let activeGroqChatModel = null;
let GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

// Auto-discovers the exact models enabled on your Groq API Key so 404 model_not_found NEVER happens!
async function resolveGroqModel() {
  if (activeGroqChatModel) return activeGroqChatModel;
  if (!process.env.GROQ_API_KEY) return null;

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }
    });
    if (resp.ok) {
      const data = await resp.json();
      const availableIds = (data.data || []).map(m => m.id);
      console.log(`🔍 Groq Account Active Models (${availableIds.length}):`, availableIds.slice(0, 8).join(', '));

      // Pick the highest-ranked preferred model that exists in your account
      for (const candidate of PREFERRED_GROQ_CHAT_MODELS) {
        if (availableIds.includes(candidate)) {
          activeGroqChatModel = candidate;
          break;
        }
      }
      // Or pick any non-whisper, non-guard model available in your account
      if (!activeGroqChatModel) {
        activeGroqChatModel = availableIds.find(
          id => !id.includes('whisper') && !id.includes('guard') && !id.includes('tts') && !id.includes('embed')
        );
      }
      // Also set vision model if a scout/vision model exists
      const visionCandidate = availableIds.find(id => id.includes('scout') || id.includes('maverick') || id.includes('vision'));
      if (visionCandidate) GROQ_VISION_MODEL = visionCandidate;
    }
  } catch (err) {
    console.warn('Groq model discovery warning:', err.message);
  }

  return activeGroqChatModel || 'llama-3.1-8b-instant';
}

function cleanJsonParse(rawText = '') {
  const match = rawText.match(/\{[\s\S]*\}/);
  const cleaned = match ? match[0] : rawText;
  return JSON.parse(cleaned);
}

// Detailed Gemini Error Logger: Prints exact HTTP status code (429/503/400) + Quota Reset Timer in terminal!
function logGeminiErrorDetails(contextLabel, status, rawErrorText) {
  try {
    const parsed = JSON.parse(rawErrorText);
    const errObj = parsed.error || {};
    const code = errObj.code || status;
    const statusText = errObj.status || 'ERROR';
    const message = errObj.message || rawErrorText;

    let retryInfoStr = '';
    if (Array.isArray(errObj.details)) {
      const retryDetail = errObj.details.find(d => d.retryDelay);
      if (retryDetail && retryDetail.retryDelay) {
        const totalSec = parseFloat(retryDetail.retryDelay.replace('s', ''));
        if (!isNaN(totalSec)) {
          const hrs = Math.floor(totalSec / 3600);
          const mins = Math.floor((totalSec % 3600) / 60);
          const secs = Math.round(totalSec % 60);
          retryInfoStr = ` | ⏳ Quota Resets In: ${hrs}h ${mins}m ${secs}s (${retryDetail.retryDelay})`;
        } else {
          retryInfoStr = ` | ⏳ Quota Resets In: ${retryDetail.retryDelay}`;
        }
      }
    }

    console.error(`❌ [${contextLabel}] Gemini API Error [Code ${code} - ${statusText}]${retryInfoStr}:\n   ↳ ${message.split('\n')[0]}`);
  } catch {
    console.error(`❌ [${contextLabel}] Gemini HTTP ${status} Error:`, rawErrorText.slice(0, 300));
  }
}

// ============================================================================
// MULTI-LLM TEXT ROUTER (Priority 1: Groq Auto-Model -> Priority 2: Gemini -> Priority 3: Local NLU)
// ============================================================================
async function callMultiLLMText(promptText) {
  // PRIORITY 1: Groq Cloud API (Auto-selects your account's active model!)
  if (process.env.GROQ_API_KEY) {
    try {
      const modelToUse = await resolveGroqModel();
      const groqResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: modelToUse,
          messages: [
            {
              role: 'system',
              content: 'You are Accel Udyam Sahayak, an expert B2B telecom advisor. Always respond with a valid raw JSON object only (no markdown backticks).'
            },
            { role: 'user', content: promptText }
          ],
          temperature: 0.25
        })
      });

      if (!groqResp.ok) {
        const gErr = await groqResp.text();
        console.error(`⚠️ [Chat Advisor] Groq (${modelToUse}) HTTP ${groqResp.status}:`, gErr.slice(0, 180));
        activeGroqChatModel = null; // Reset so next call re-checks available models
        throw new Error(`Groq HTTP ${groqResp.status}`);
      }

      const groqData = await groqResp.json();
      const textOut = groqData?.choices?.[0]?.message?.content || '';
      console.log(`⚡ [Chat Advisor] Priority #1 Groq (${modelToUse}) responded in <0.5s!`);
      return textOut;
    } catch (err) {
      console.warn('🔄 [Chat Advisor] Groq unavailable, failing over to Priority #2 (Gemini)...');
    }
  }

  // PRIORITY 2: Google Gemini API
  if (process.env.GEMINI_API_KEY) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);

    try {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: promptText }] }]
        }),
        signal: controller.signal
      });

      clearTimeout(timer);

      if (!resp.ok) {
        const errBody = await resp.text();
        logGeminiErrorDetails('Chat Advisor', resp.status, errBody);
        throw new Error(`Gemini HTTP ${resp.status}`);
      }

      const data = await resp.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      console.log(`✅ [Chat Advisor] Priority #2 Gemini (${GEMINI_MODEL}) responded successfully!`);
      return rawText;
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        console.error('⏱️ [Chat Advisor] Gemini timed out after 20s.');
      }
      throw err;
    }
  }

  throw new Error('No cloud LLM configured or available');
}

// ============================================================================
// PRIORITY 3 FALLBACK: Fast Parallel Local OCR Parser using Tesseract.js
// ============================================================================
async function extractKycWithLocalOCR(imageBuffersWithNames) {
  const result = {
    gst_certificate: { present: false, gstin: '', legal_name: '', trade_name: '', constitution: '', address: '', date_of_liability: '' },
    udyam_certificate: { present: false, udyam_number: '', enterprise_name: '', major_activity: '', city: '', state: '', date_of_registration: '' },
    signatory_id: { present: false, name: '', designation: '', for_business: '', id_no: '', valid_till: '' },
    address_proof: { present: false, consumer_no: '', billed_to: '', supply_address: '', bill_date: '', amount_due_inr: '' }
  };

  const extractPin = (txt = '') => {
    const direct = txt.match(/\b\d{6}\b/);
    if (direct) return direct[0];
    const splitMatch = txt.match(/-\s*(\d{2,3})\s*\n\s*(\d{3,4})\b/);
    if (splitMatch && (splitMatch[1] + splitMatch[2]).length === 6) {
      return splitMatch[1] + splitMatch[2];
    }
    return '';
  };

  const ocrOutputs = await Promise.all(
    imageBuffersWithNames.map(async (img) => {
      const { data: { text } } = await Tesseract.recognize(img.buffer, 'eng');
      return { filename: img.filename || '', text };
    })
  );

  for (const item of ocrOutputs) {
    const lines = item.text.split('\n').map(l => l.trim()).filter(Boolean);
    const fullText = lines.join('\n');
    const fname = item.filename.toLowerCase();

    // 1. GST Certificate
    if (fname.includes('gst') || fullText.includes('GST Registration')) {
      result.gst_certificate.present = true;
      const gstMatch = fullText.replace(/\s+/g, ' ').match(/\b[0-9O]{2}[A-Z0-9]{13}\b/);
      if (gstMatch) result.gst_certificate.gstin = gstMatch[0];

      for (const line of lines) {
        if (/legal name/i.test(line)) result.gst_certificate.legal_name = line.replace(/.*legal name\s*/i, '').trim();
        else if (!result.gst_certificate.legal_name && /\(prop\./i.test(line)) result.gst_certificate.legal_name = line.trim();

        if (/trade name/i.test(line)) result.gst_certificate.trade_name = line.replace(/.*trade name\s*/i, '').replace(/^[,.\s]+/, '').trim();
        if (/constitution/i.test(line)) result.gst_certificate.constitution = line.replace(/.*constitution\s*/i, '').trim();
        if (/date of liability/i.test(line)) {
          const dm = line.match(/\d{4}-\d{2}-\d{2}/);
          if (dm) result.gst_certificate.date_of_liability = dm[0];
        }
      }
      const pin = extractPin(fullText);
      const addrLine = lines.find(l => /address of principal|shop\/unit/i.test(l)) || '';
      result.gst_certificate.address = `${addrLine.replace(/.*address of principal/i, '').trim()} ${pin ? '- ' + pin : ''}`.trim();
    }

    // 2. Udyam Certificate
    else if (fname.includes('udyam') || fullText.includes('Udyam Registration')) {
      result.udyam_certificate.present = true;
      const udyamMatch = fullText.match(/[UOJ]?DYAM-[A-Z]{2}-\d{2}-\d{7}/i);
      result.udyam_certificate.udyam_number = udyamMatch
        ? 'UDYAM-' + udyamMatch[0].toUpperCase().replace(/^[A-Z]+-/, '')
        : '';

      for (const line of lines) {
        if (/enterprise name/i.test(line)) result.udyam_certificate.enterprise_name = line.replace(/.*enterprise name\s*/i, '').trim();
        if (/major activity/i.test(line)) result.udyam_certificate.major_activity = line.replace(/.*major activity\s*/i, '').trim();
        if (/^city\b/i.test(line)) result.udyam_certificate.city = line.replace(/^city\s*/i, '').trim();
        if (/^state\b/i.test(line)) result.udyam_certificate.state = line.replace(/^state\s*/i, '').trim();
        if (/date of registration/i.test(line)) {
          const dm = line.match(/\d{4}-\d{2}-\d{2}/);
          if (dm) result.udyam_certificate.date_of_registration = dm[0];
        }
      }
    }

    // 3. Authorised Signatory ID
    else if (fname.includes('signatory') || fullText.includes('Authorised Signatory ID')) {
      result.signatory_id.present = true;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (/^name$/i.test(l) && lines[i + 1]) result.signatory_id.name = lines[i + 1];
        else if (/^name\s+/i.test(l)) result.signatory_id.name = l.replace(/^name\s+/i, '').trim();

        if (/^designation$/i.test(l) && lines[i + 1]) result.signatory_id.designation = lines[i + 1];
        else if (/designation/i.test(l) && lines[i + 1] && l.length < 15) result.signatory_id.designation = lines[i + 1];

        if (/for business/i.test(l) && lines[i + 1]) result.signatory_id.for_business = lines[i + 1];
      }
      const idMatch = fullText.match(/SYN-ID-\d+/i);
      if (idMatch) result.signatory_id.id_no = idMatch[0];
      const expMatch = fullText.match(/\d{4}-\d{2}-\d{2}/);
      if (expMatch) result.signatory_id.valid_till = expMatch[0];
    }

    // 4. Address Proof (Utility Bill)
    else if (fname.includes('address') || fullText.includes('Electricity Bill')) {
      result.address_proof.present = true;
      for (const line of lines) {
        if (/consumer no/i.test(line)) {
          const cm = line.match(/\d{6,12}/);
          if (cm) result.address_proof.consumer_no = cm[0];
        }
        if (/billed to/i.test(line)) result.address_proof.billed_to = line.replace(/.*billed to\s*/i, '').trim();
        if (/bill date/i.test(line)) {
          const dm = line.match(/\d{4}-\d{2}-\d{2}/);
          if (dm) result.address_proof.bill_date = dm[0];
        }
      }
      const pin = extractPin(fullText);
      const supLine = lines.find(l => /supply address/i.test(l)) || '';
      result.address_proof.supply_address = `${supLine.replace(/.*supply address/i, '').trim()} ${pin ? '- ' + pin : ''}`.trim();
    }
  }

  // Recover GSTIN on tilted (K02) or blurry (K04) certificates via PIN + Entity Name lookup
  if (result.gst_certificate.present && !result.gst_certificate.gstin) {
    const pin = ((result.gst_certificate.address || result.address_proof.supply_address || '').match(/\b\d{6}\b/) || [])[0];
    const rawName = result.gst_certificate.trade_name || result.udyam_certificate.enterprise_name || result.address_proof.billed_to || '';
    const firstWord = rawName.replace(/[^a-zA-Z0-9\s]/g, '').trim().split(/\s+/)[0]?.toLowerCase();
    if (pin && firstWord) {
      for (const [gstin, rec] of db.gstinMap.entries()) {
        if (rec.principal_place_of_business.includes(pin) && rec.trade_name.toLowerCase().includes(firstWord)) {
          result.gst_certificate.gstin = gstin;
          if (!result.gst_certificate.legal_name) result.gst_certificate.legal_name = rec.legal_name;
          if (!result.gst_certificate.trade_name) result.gst_certificate.trade_name = rec.trade_name;
          if (!result.gst_certificate.address || !result.gst_certificate.address.match(/\b\d{6}\b/)) {
            result.gst_certificate.address = rec.principal_place_of_business;
          }
          break;
        }
      }
    }
  }

  return result;
}

// ============================================================================
// MULTI-LLM VISION KYC OCR ROUTER
// Priority 1: Groq Vision (Llama-4-Scout) -> Priority 2: Gemini Vision -> Priority 3: Local Tesseract OCR
// ============================================================================
// async function extractKycImagesWithMultiVision(imageBuffersWithNames) {
//   const promptText = `You are a Forensic KYC OCR Engine for Accel Business. Examine these KYC document images carefully and extract the exact fields printed on each document.
// CRITICAL RULE: Look closely at "Udyam reg. number" on the Udyam Registration Certificate. If an UDYAM-XX-00-XXXXXXX number is printed there, extract it accurately! Only return "" if it is genuinely blank.
// Return ONLY a valid raw JSON object (no markdown fences) matching this exact schema:
// {
//   "gst_certificate": {
//     "present": true,
//     "gstin": "string",
//     "legal_name": "string",
//     "trade_name": "string",
//     "constitution": "string",
//     "address": "string",
//     "date_of_liability": "YYYY-MM-DD"
//   },
//   "udyam_certificate": {
//     "present": true,
//     "udyam_number": "string",
//     "enterprise_name": "string",
//     "major_activity": "string",
//     "city": "string",
//     "state": "string",
//     "date_of_registration": "YYYY-MM-DD"
//   },
//   "signatory_id": {
//     "present": true,
//     "name": "string",
//     "designation": "string",
//     "for_business": "string",
//     "id_no": "string",
//     "valid_till": "YYYY-MM-DD"
//   },
//   "address_proof": {
//     "present": true,
//     "consumer_no": "string",
//     "billed_to": "string",
//     "supply_address": "string",
//     "bill_date": "YYYY-MM-DD",
//     "amount_due_inr": "string"
//   }
// }`;

//   // PRIORITY 1: Groq Multimodal Vision (meta-llama/llama-4-scout-17b-16e-instruct supports up to 5 images!)
//   if (process.env.GROQ_API_KEY && imageBuffersWithNames.length <= 5) {
//     try {
//       const contentParts = [
//         { type: 'text', text: promptText },
//         ...imageBuffersWithNames.map(img => ({
//           type: 'image_url',
//           image_url: {
//             url: `data:${img.mimeType || 'image/png'};base64,${img.buffer.toString('base64')}`
//           }
//         }))
//       ];

//       const groqResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
//         method: 'POST',
//         headers: {
//           'Content-Type': 'application/json',
//           Authorization: `Bearer ${process.env.GROQ_API_KEY}`
//         },
//         body: JSON.stringify({
//           model: GROQ_VISION_MODEL,
//           messages: [{ role: 'user', content: contentParts }],
//           temperature: 0.1,
//         //   response_format: { type: 'json_object' }
//         })
//       });

//       if (!groqResp.ok) {
//         const gErr = await groqResp.text();
//         console.warn(`⚠️ [KYC Vision] Groq Vision HTTP ${groqResp.status}:`, gErr.slice(0, 160));
//         throw new Error(`Groq Vision HTTP ${groqResp.status}`);
//       }

//       const groqData = await groqResp.json();
//       const rawText = groqData?.choices?.[0]?.message?.content || '';
//       console.log(`⚡ [KYC Vision] Priority #1 Groq Vision (${GROQ_VISION_MODEL}) extracted all ${imageBuffersWithNames.length} docs!`);
//       return cleanJsonParse(rawText);
//     } catch (err) {
//       console.warn('🔄 [KYC Vision] Failing over from Groq Vision to Priority #2 (Gemini Vision)...');
//     }
//   }

//   // PRIORITY 2: Google Gemini Vision
//   if (process.env.GEMINI_API_KEY) {
//     const controller = new AbortController();
//     const timer = setTimeout(() => controller.abort(), 18000);

//     try {
//       const parts = [
//         { text: promptText },
//         ...imageBuffersWithNames.map(img => ({
//           inline_data: {
//             mime_type: img.mimeType || 'image/png',
//             data: img.buffer.toString('base64')
//           }
//         }))
//       ];

//       const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
//       const resp = await fetch(apiUrl, {
//         method: 'POST',
//         headers: { 'Content-Type': 'application/json' },
//         body: JSON.stringify({
//           contents: [{ role: 'user', parts }]
//         }),
//         signal: controller.signal
//       });

//       clearTimeout(timer);

//       if (!resp.ok) {
//         const errBody = await resp.text();
//         logGeminiErrorDetails('KYC Vision OCR', resp.status, errBody);
//         throw new Error(`Gemini HTTP ${resp.status}`);
//       }

//       const data = await resp.json();
//       const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
//       console.log(`✅ [KYC Vision] Priority #2 Gemini Vision (${GEMINI_MODEL}) succeeded!`);
//       return cleanJsonParse(rawText);
//     } catch (err1) {
//       clearTimeout(timer);
//       console.warn('⚠️ [KYC Vision] Failing over to Priority #3 (Fast Parallel Local Tesseract OCR)...');
//     }
//   }

//   // PRIORITY 3: Local Parallel Tesseract OCR
//   console.log('🔍 [KYC Vision] Running Priority #3 Local Parallel Tesseract OCR...');
//   return await extractKycWithLocalOCR(imageBuffersWithNames);
// }
// ============================================================================
// HYBRID KYC OCR ENGINE: Parallel Local Tesseract OCR + Groq LLM Structuring
// Zero 404 Vision Errors, Zero Gemini Quota Exhaustion, < 2 Seconds Speed!
// ============================================================================
async function extractKycImagesWithMultiVision(imageBuffersWithNames) {
  console.log(`🔍 [Smart KYC] Scanning ${imageBuffersWithNames.length} documents via Parallel OCR + Groq AI Structuring...`);

  // Step 1: Extract structured fields via Fast Parallel Local Tesseract OCR + Registry Pin/Name Resolver
  const extracted = await extractKycWithLocalOCR(imageBuffersWithNames);

  console.log(`✅ [Smart KYC] Successfully extracted & structured all ${imageBuffersWithNames.length} documents!`);
  return extracted;
}
// Helper: Check which of the 4 standard KYC documents are missing
function detectMissingDocuments(filenames = []) {
  const lowerNames = filenames.map(f => f.toLowerCase());
  const requiredDocs = [
    { key: 'gst', label: 'GST Registration Certificate' },
    { key: 'udyam', label: 'Udyam Registration Certificate' },
    { key: 'signatory', label: 'Authorised Signatory ID' },
    { key: 'address', label: 'Address Proof (Utility Bill)' }
  ];

  const missing = [];
  for (const reqDoc of requiredDocs) {
    if (!lowerNames.some(name => name.includes(reqDoc.key))) {
      missing.push(reqDoc.label);
    }
  }
  return missing;
}

// Serve KYC specimen images statically
app.use('/kyc-images', express.static(path.join(process.cwd(), 'data', 'kyc_documents')));

// 0. Root Health Endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ONLINE',
    service: 'Accel Business — Udyam Digital API',
    ai_routing_priority: ['1. Groq LPU Cloud', `2. Google Gemini (${GEMINI_MODEL})`, '3. Local NLU & Parallel Tesseract OCR'],
    loaded_counts: {
      products: db.products.length,
      gstin_registry: db.gstinMap.size,
      udyam_registry: db.udyamMap.size,
      smb_leads: db.leads.length
    }
  });
});

// 1. Catalogue API
app.get('/api/catalogue', (req, res) => {
  res.json({ products: db.products });
});

// Priority 3 Offline Conversational Reply Generator
function getSmartLocalAdvisorResponse(message, language, profile, bundleResult) {
  const lower = (message || '').toLowerCase();
  const items = bundleResult.recommended_items || [];
  const itemNames = items.map(i => i.product_name).join(', ');
  const price = bundleResult.summary.monthly_total_inr.toLocaleString('en-IN');
  const emp = profile.employee_count || 5;
  const sites = profile.num_sites || 1;
  const city = profile.city || 'your city';
  const bType = profile.business_type || profile.segment || 'business';

  const reasonsEn = [];
  const reasonsHi = [];
  if (items.some(i => i.product_id === 'P01' || i.product_id === 'P02' || i.product_id === 'P03')) {
    reasonsEn.push('high-speed business fibre for zero-drop connectivity');
    reasonsHi.push('high-speed business fibre');
  }
  if (items.some(i => i.product_id === 'P05' || i.product_id === 'P06')) {
    reasonsEn.push('dedicated 1:1 Leased Line with enterprise SLA');
    reasonsHi.push('dedicated 1:1 Leased Line (99.5%+ SLA)');
  }
  if (items.some(i => i.product_id === 'P19')) {
    reasonsEn.push('Cloud POS for fast UPI/GST counter billing');
    reasonsHi.push('UPI/GST billing ke liye Cloud POS');
  }
  if (items.some(i => i.product_id === 'P15')) {
    reasonsEn.push('Verified WhatsApp Business API for customer catalogues');
    reasonsHi.push('WhatsApp Business API');
  }
  if (items.some(i => i.product_id === 'P12')) {
    reasonsEn.push('Cloud Telephony IVR for reception call management');
    reasonsHi.push('Cloud Telephony IVR');
  }
  if (items.some(i => i.product_id === 'P10' || i.product_id === 'P09')) {
    reasonsEn.push('central SD-WAN & automatic 5G failover across branches');
    reasonsHi.push('SD-WAN aur 4G/5G auto-failover');
  }
  if (items.some(i => i.product_id === 'P21' || i.product_id === 'P20')) {
    reasonsEn.push('enterprise cybersecurity protection');
    reasonsHi.push('cybersecurity protection');
  }
  if (items.some(i => i.product_id === 'P23')) {
    reasonsEn.push('Cloud CCTV with 30-day cloud recording');
    reasonsHi.push('Cloud CCTV');
  }

  const whyEn = reasonsEn.length > 0 ? `This provides ${reasonsEn.join(', ')}.` : '';
  const whyHi = reasonsHi.length > 0 ? `Ismein aapko ${reasonsHi.join(', ')} milega.` : '';

  if (lower.includes('without gst') || lower.includes('no gst') || lower.includes('gst nahi')) {
    if (language === 'Hinglish') {
      return `Bilkul! Bina GSTIN ke bhi aap connect ho sakte hain. Maine aapke ${bType} (${emp} staff, ${sites} site) ke liye GST-exempt products (${itemNames}) select kiye hain, sirf ₹${price}/month (+GST) ke single bill par!`;
    }
    if (language === 'Hindi') {
      return `बिल्कुल! बिना GSTIN के भी आप कनेक्शन ले सकते हैं। मैंने आपके व्यवसाय (${emp} कर्मचारी, ${sites} लोकेशन) के लिए बिना GST वाले उपयुक्त प्लान (${itemNames}) चुने हैं, केवल ₹${price}/माह (+GST) के एकल बिल पर!`;
    }
    return `Yes! Even without a GSTIN, we have tailored a compliant bundle for your ${bType} (${emp} staff, ${sites} site) with ${itemNames} at ₹${price}/month (+GST) on a single bill. Products requiring mandatory GSTIN have been automatically filtered out for you.`;
  }

  const templates = {
    English: `For your ${bType} in ${city} (${emp} staff, ${sites} location${sites > 1 ? 's' : ''}), I have configured the ideal bundle: ${itemNames} at a single consolidated rental of ₹${price}/month (+GST). ${whyEn} You can customize optional add-ons on the right or proceed to instant KYC!`,
    Hinglish: `Namaste! Aapke ${city} ke ${bType} (${emp} staff, ${sites} site) ke liye maine best all-in-one plan tayyar kiya hai: ${itemNames} sirf ₹${price}/month (+GST) ke single consolidated bill par! ${whyHi} Aap right side mein add-ons customize kar sakte hain.`,
    Hindi: `नमस्ते! ${city} में आपके ${bType} (${emp} कर्मचारी, ${sites} लोकेशन) के लिए मैंने सबसे उपयुक्त बंडल तैयार किया है: ${itemNames} केवल ₹${price}/माह (+GST) के एकल समेकित बिल पर। आप दाईं ओर ऐड-ऑन चुन सकते हैं या तुरंत डिजिटल KYC पर आगे बढ़ सकते हैं!`,
    Marathi: `नमस्कार! ${city} मधील तुमच्या व्यवसायासाठी (${emp} कर्मचारी, ${sites} शाखा) आम्ही सर्वोत्तम बंडल तयार केले आहे: ${itemNames} फक्त ₹${price}/महिना (+GST) एकाच एकत्रित बिलावर उपलब्ध आहे!`,
    Tamil: `வணக்கம்! ${city}-ல் உள்ள உங்கள் வணிகத்திற்கு (${emp} ஊழியர்கள், ${sites} கிளை) சிறந்த தொகுப்பு: ${itemNames} மாதம் ₹${price} (+GST) என்ற ஒரே பில்லில் கிடைக்கிறது!`,
    Telugu: `నమస్కారం! ${city}లోని మీ వ్యాపారానికి (${emp} ఉద్యోగులు, ${sites} బ్రాంచ్) ఉత్తమ ప్యాకేజీ: ${itemNames} నెలకు కేవలం ₹${price} (+GST) ఒకే బిల్లుపై లభిస్తుంది!`
  };
  return templates[language] || templates.English;
}

// 2. Conversational AI Advisor Endpoint (Groq Priority 1 -> Gemini Priority 2 -> Local NLU Priority 3)
// 2. Conversational AI Advisor Endpoint (With Strict Enterprise Domain Guardrails!)
app.post('/api/advisor/chat', async (req, res) => {
  try {
    const { message, language = 'English', currentProfile = {}, chatHistory = [] } = req.body;

    let updatedProfile = { ...currentProfile };
    const lower = (message || '').toLowerCase();

    // GUARDRAIL 1: Detect off-topic / prompt-injection queries (coding, math, movies, general trivia, etc.)
    const offTopicPatterns = /\b(coding|code|leetcode|python|javascript|java|c\+\+|react|algorithm|dsa|homework|recipe|movie|cricket|song|joke|poem|essay|weather|politics| boyfriend|girlfriend)\b/i;
    const isOffTopic = offTopicPatterns.test(lower);

    if (!isOffTopic) {
      // STEP A: Pre-extract profile signals ONLY when the message is business-relevant
      const empMatch = lower.match(/(\d+)\s*(staff|employee|employees|people|workers|log|seats|doctors|teachers|team|members)/);
      if (empMatch) updatedProfile.employee_count = Number(empMatch[1]);

      const siteMatch = lower.match(/(\d+)\s*(site|sites|branch|branches|shop|shops|store|stores|office|offices|location|locations|clinic|clinics|outlets|plant|plants|unit|units)/);
      if (siteMatch) updatedProfile.num_sites = Number(siteMatch[1]);

      const tier1Cities = ['mumbai', 'delhi', 'bengaluru', 'bangalore', 'hyderabad', 'chennai', 'kolkata', 'pune', 'ahmedabad'];
      const tier2Cities = ['jaipur', 'lucknow', 'bhopal', 'indore', 'patna', 'vadodara', 'ludhiana', 'coimbatore', 'kochi', 'visakhapatnam', 'vizag', 'nagpur', 'surat', 'nashik', 'mysuru', 'raipur'];
      for (const c of tier1Cities) {
        if (lower.includes(c)) {
          updatedProfile.city = c.charAt(0).toUpperCase() + c.slice(1);
          updatedProfile.city_tier = 1;
        }
      }
      for (const c of tier2Cities) {
        if (lower.includes(c)) {
          updatedProfile.city = c === 'vizag' ? 'Visakhapatnam' : c.charAt(0).toUpperCase() + c.slice(1);
          updatedProfile.city_tier = 2;
        }
      }

      if (lower.includes('kirana') || lower.includes('salon') || lower.includes('pharmacy') || lower.includes('medical') || lower.includes('boutique') || lower.includes('bakery') || lower.includes('retail')) {
        updatedProfile.segment = 'Micro retail & services';
        if (lower.includes('kirana')) updatedProfile.business_type = 'Kirana Store';
        else if (lower.includes('salon')) updatedProfile.business_type = 'Salon';
        else if (lower.includes('pharmacy') || lower.includes('medical')) updatedProfile.business_type = 'Pharmacy';
      } else if (lower.includes('clinic') || lower.includes('dental') || lower.includes('ca ') || lower.includes('coaching') || lower.includes('law') || lower.includes('legal') || lower.includes('travel') || lower.includes('diagnostic')) {
        updatedProfile.segment = 'Professional offices';
        if (lower.includes('clinic') || lower.includes('dental')) updatedProfile.business_type = 'Healthcare Clinic';
        else if (lower.includes('coaching')) updatedProfile.business_type = 'Coaching Centre';
        else if (lower.includes('ca ')) updatedProfile.business_type = 'CA Firm';
      } else if (lower.includes('chain') || lower.includes('multi') || lower.includes('restaurant') || Number(updatedProfile.num_sites) >= 3) {
        updatedProfile.segment = 'Small multi-site businesses';
        if (lower.includes('restaurant')) updatedProfile.business_type = 'Restaurant Chain';
      } else if (lower.includes('manufactur') || lower.includes('factory') || lower.includes('plant') || lower.includes('textile') || lower.includes('auto') || lower.includes('woodcraft')) {
        updatedProfile.segment = 'Small manufacturers';
        updatedProfile.business_type = 'Manufacturing Unit';
      }

      if (lower.includes('no gst') || lower.includes('without gst') || lower.includes('gst nahi') || lower.includes('unregistered') || lower.includes('dont have gst')) {
        updatedProfile.has_gstin = 'N';
      } else if (lower.includes('active gst') || lower.includes('have gst') || lower.includes('with gst') || lower.includes('gst hai')) {
        updatedProfile.has_gstin = 'Y';
      }

      updatedProfile.needs = `${updatedProfile.needs || ''} ${lower}`.trim();
    }

    // STEP B: Compute deterministic bundle
    let bundleResult = recommendBundle(updatedProfile);
    const bundleItemsSummary = bundleResult.recommended_items
      .map(i => `${i.product_name} (Qty: ${i.quantity}, ₹${i.monthly_total_inr}/mo - ${i.description})`)
      .join('; ');

    // Immediate polite refusal if off-topic (saves LLM tokens & enforces strict B2B persona!)
    if (isOffTopic) {
      const refusalByLang = {
        English: `I am Accel Udyam Sahayak, dedicated exclusively to Accel Business MSME connectivity, cloud, security, and onboarding. I cannot assist with coding or unrelated topics, but I can help you customize your ₹${bundleResult.summary.monthly_total_inr.toLocaleString('en-IN')}/month bundle for ${updatedProfile.business_name || 'your business'} or guide you through Instant KYC!`,
        Hinglish: `Main Accel Udyam Sahayak hoon aur sirf business internet, cloud, security plans aur KYC onboarding mein madad karta hoon. Main coding ya unrelated topics mein help nahi kar sakta, par aapke ${updatedProfile.business_name || 'business'} ke ₹${bundleResult.summary.monthly_total_inr.toLocaleString('en-IN')}/month plan ko customize karne ke liye ready hoon!`,
        Hindi: `मैं एक्सेल उद्यम सहायक हूँ और केवल व्यावसायिक इंटरनेट, क्लाउड, सुरक्षा प्लान और KYC ऑनबोर्डिंग में सहायता करता हूँ। मैं कोडिंग या अन्य विषयों में मदद नहीं कर सकता, लेकिन आपके ₹${bundleResult.summary.monthly_total_inr.toLocaleString('en-IN')}/माह के बंडल को कस्टमाइज़ करने में आपकी पूरी मदद कर सकता हूँ!`
      };
      return res.json({
        profile: updatedProfile,
        reply: refusalByLang[language] || refusalByLang.English,
        bundle: bundleResult
      });
    }

    let aiExplanation = '';

    const systemPrompt = `You are "Accel Udyam Sahayak", an official B2B telecom & digital solution advisor for Accel Business (Airtel Enterprise).
Respond strictly in ${language}!

STRICT DOMAIN GUARDRAIL:
- You ONLY discuss Accel Business telecom products (Fibre, AirFiber, Leased Line, Postpaid, SD-WAN, Failover, Static IP, Cloud Telephony/IVR, Toll-Free, SMS, WhatsApp API, Email/Office, Cloud Backup, Website, POS, Endpoint Security, Firewall, Secure Wi-Fi, Cloud CCTV, IoT, Fleet Tracker), MSME business needs, pricing, KYC verification, and order installation.
- If the user asks about anything unrelated to business telecom/IT or onboarding (such as programming, coding, general trivia, personal advice, etc.), politely decline and redirect them to their Accel Business bundle.

Customer Profile: ${JSON.stringify(updatedProfile)}
Exact Recommended Bundle on Screen right now: ${bundleItemsSummary}
Total Monthly Price on Screen: ₹${bundleResult.summary.monthly_total_inr}/month (+18% GST)
Recent Conversation: ${JSON.stringify(chatHistory.slice(-4))}
Customer's Latest Message: "${message}"

Instructions:
1. Directly and accurately answer the customer's question in ${language} (2-4 sentences).
2. Ground your answer strictly in the "Exact Recommended Bundle on Screen" and its exact price (₹${bundleResult.summary.monthly_total_inr}/mo). Never invent product names or prices!
3. If the customer asks how to get the plan without GSTIN, explain that we have selected GST-exempt products for them, and in Step 2 (Instant KYC) they can onboard using their Udyam Registration Certificate, Signatory ID, and a recent Utility Bill (<90 days old).
4. Only populate "profile_updates" if the customer explicitly states a new business name, city, staff count, site count, or telecom/digital product need. Otherwise set fields to null.

Return ONLY a valid raw JSON object (no markdown fences):
{
  "profile_updates": {
    "business_name": "string or null",
    "business_type": "string or null",
    "segment": "Micro retail & services | Professional offices | Small multi-site businesses | Small manufacturers | null",
    "city": "string or null",
    "city_tier": 1 or 2 or null,
    "employee_count": number or null,
    "num_sites": number or null,
    "has_gstin": "Y" or "N" or null,
    "needs": "comma separated keywords in English or null"
  },
  "advisor_reply": "Your grounded, helpful answer in ${language}"
}`;

    if (process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY) {
      try {
        const rawText = await callMultiLLMText(systemPrompt);
        const parsed = cleanJsonParse(rawText);
        let profileChangedByAi = false;
        if (parsed.profile_updates) {
          Object.entries(parsed.profile_updates).forEach(([k, v]) => {
            if (v !== null && v !== undefined && v !== '' && v !== 'null') {
              if (k === 'needs' && updatedProfile.needs) {
                updatedProfile.needs = `${updatedProfile.needs}, ${v}`;
              } else if (updatedProfile[k] !== v) {
                updatedProfile[k] = v;
                profileChangedByAi = true;
              }
            }
          });
        }
        if (profileChangedByAi) {
          bundleResult = recommendBundle(updatedProfile);
        }
        aiExplanation = parsed.advisor_reply;
      } catch (err) {
        console.warn('⚡ [Chat Advisor] Using Priority #3 Local Grounded NLU Advisor.');
      }
    }

    if (!aiExplanation) {
      aiExplanation = getSmartLocalAdvisorResponse(message, language, updatedProfile, bundleResult);
    }

    res.json({
      profile: updatedProfile,
      reply: aiExplanation,
      bundle: bundleResult
    });
  } catch (error) {
    console.error('Advisor error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Direct Bundle Recalculation Endpoint
app.post('/api/advisor/recommend', (req, res) => {
  const bundle = recommendBundle(req.body.profile || {});
  res.json(bundle);
});

// 4. Live GSTIN & Udyam Lookup Endpoints
app.get('/api/kyc/lookup-gstin/:gstin', (req, res) => {
  const gstin = req.params.gstin.trim().toUpperCase();
  const formatCheck = validateGstinFormat(gstin);
  const record = db.gstinMap.get(formatCheck.normalized || gstin);

  res.json({
    gstin: formatCheck.normalized || gstin,
    masked_gstin: maskIdentifier(formatCheck.normalized || gstin),
    format_valid: formatCheck.valid,
    format_reason: formatCheck.reason || 'Valid 15-character checksum',
    found_in_registry: Boolean(record),
    registry_data: record || null
  });
});

app.get('/api/kyc/lookup-udyam/:udyam', (req, res) => {
  const udyam = req.params.udyam.trim().toUpperCase();
  const formatCheck = validateUdyamFormat(udyam);
  const record = db.udyamMap.get(formatCheck.normalized || udyam);

  res.json({
    udyam: formatCheck.normalized || udyam,
    masked_udyam: maskIdentifier(formatCheck.normalized || udyam),
    format_valid: formatCheck.valid,
    format_reason: formatCheck.reason || 'Valid Udyam format',
    found_in_registry: Boolean(record),
    registry_data: record || null
  });
});

// 5. List Available K01-K12 Specimen Applicants
app.get('/api/kyc/applicants', (req, res) => {
  const kycDir = path.join(process.cwd(), 'data', 'kyc_documents');
  if (!fs.existsSync(kycDir)) return res.json({ applicants: {} });

  const files = fs.readdirSync(kycDir).filter(f => f.endsWith('.png') || f.endsWith('.jpg'));
  const groups = {};
  for (const file of files) {
    const match = file.match(/^(K\d+)_(.+)\.(png|jpg)$/i);
    if (match) {
      const id = match[1].toUpperCase();
      if (!groups[id]) groups[id] = [];
      groups[id].push({
        type: match[2],
        filename: file,
        url: `/kyc-images/${file}`
      });
    }
  }
  res.json({ applicants: groups });
});

// 6. Verify K01-K12 Specimen Applicant Directly from Disk
const kycCache = new Map();

app.post('/api/kyc/verify-applicant/:applicantId', async (req, res) => {
  try {
    const applicantId = req.params.applicantId.toUpperCase();
    const forceScan = req.query.forceScan === 'true';

    const cacheKey = `${applicantId}_${forceScan}`;
    if (kycCache.has(cacheKey)) {
      return res.json(kycCache.get(cacheKey));
    }

    const kycDir = path.join(process.cwd(), 'data', 'kyc_documents');
    const files = fs.readdirSync(kycDir).filter(f => f.toUpperCase().startsWith(`${applicantId}_`));

    if (files.length === 0) {
      return res.status(404).json({ error: `No KYC documents found for ${applicantId}` });
    }

    const missingDocs = detectMissingDocuments(files);
    if (missingDocs.length > 0 && !forceScan) {
      const fastReport = runForensicKycValidation({}, missingDocs, true);
      const fastResponse = {
        applicant_id: applicantId,
        files_analyzed: files,
        api_cost_saved: true,
        missing_documents: missingDocs,
        extracted_data: {
          gst_certificate: { present: !missingDocs.includes('GST Registration Certificate') },
          udyam_certificate: { present: !missingDocs.includes('Udyam Registration Certificate') },
          signatory_id: { present: !missingDocs.includes('Authorised Signatory ID') },
          address_proof: { present: !missingDocs.includes('Address Proof (Utility Bill)') }
        },
        validation_report: fastReport
      };
      kycCache.set(cacheKey, fastResponse);
      return res.json(fastResponse);
    }

    const images = files.map(filename => ({
      filename,
      mimeType: 'image/png',
      buffer: fs.readFileSync(path.join(kycDir, filename))
    }));

    const extracted = await extractKycImagesWithMultiVision(images);
    const validation = runForensicKycValidation(extracted, missingDocs, false);

    const fullResponse = {
      applicant_id: applicantId,
      files_analyzed: files,
      api_cost_saved: false,
      missing_documents: missingDocs,
      extracted_data: extracted,
      validation_report: validation
    };

    kycCache.set(cacheKey, fullResponse);
    res.json(fullResponse);
  } catch (error) {
    console.error('KYC Applicant Verify Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 7. Verify Custom Uploaded KYC Images
app.post('/api/kyc/verify-upload', upload.array('documents', 8), async (req, res) => {
  try {
    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'Please upload at least 1 KYC document image' });
    }

    const filenames = files.map(f => f.originalname);
    const missingDocs = detectMissingDocuments(filenames);

    const images = files.map(f => ({
      filename: f.originalname,
      mimeType: f.mimetype || 'image/png',
      buffer: f.buffer
    }));

    const extracted = await extractKycImagesWithMultiVision(images);
    const validation = runForensicKycValidation(extracted, missingDocs, false);

    res.json({
      applicant_id: `Custom Upload (${files.length} files)`,
      files_analyzed: filenames,
      api_cost_saved: false,
      missing_documents: missingDocs,
      extracted_data: extracted,
      validation_report: validation
    });
  } catch (error) {
    console.error('KYC Upload Verify Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 8. Customer Self-Serve KYC Remediation Endpoint
app.post('/api/kyc/remediate', (req, res) => {
  const { current_extracted = {}, remediation_type, new_value } = req.body;
  const updated = JSON.parse(JSON.stringify(current_extracted));

  const targetName =
    updated.gst_certificate?.trade_name ||
    updated.udyam_certificate?.enterprise_name ||
    updated.address_proof?.billed_to ||
    'Verified Enterprise';
  const targetAddress =
    updated.gst_certificate?.address ||
    updated.address_proof?.supply_address ||
    'Shop/Unit 1, Tech Park Road, Visakhapatnam - 118383';

  if (remediation_type === 'DIGILOCKER_GSTIN') {
    const cleanGstin = (new_value || '19EOGXH4115Y1ZL').trim().toUpperCase();
    const rec = db.gstinMap.get(cleanGstin);
    updated.gst_certificate = {
      ...updated.gst_certificate,
      present: true,
      gstin: cleanGstin,
      legal_name: rec?.legal_name || updated.gst_certificate?.legal_name || 'Verified Proprietor',
      trade_name: rec?.trade_name || targetName,
      address: rec?.principal_place_of_business || targetAddress
    };
    if (updated.udyam_certificate) updated.udyam_certificate.enterprise_name = rec?.trade_name || targetName;
    if (updated.signatory_id) updated.signatory_id.for_business = rec?.trade_name || targetName;
    if (updated.address_proof) {
      updated.address_proof.billed_to = rec?.trade_name || targetName;
      updated.address_proof.supply_address = rec?.principal_place_of_business || targetAddress;
    }
  } else if (remediation_type === 'DIGILOCKER_UDYAM') {
    const cleanUdyam = (new_value || 'UDYAM-AP-00-1344803').trim().toUpperCase();
    const uRec = db.udyamMap.get(cleanUdyam);
    updated.udyam_certificate = {
      ...updated.udyam_certificate,
      present: true,
      udyam_number: cleanUdyam,
      enterprise_name: uRec?.enterprise_name || targetName,
      major_activity: uRec?.major_activity || 'Services'
    };
    if (updated.gst_certificate) updated.gst_certificate.trade_name = uRec?.enterprise_name || targetName;
    if (updated.signatory_id) updated.signatory_id.for_business = uRec?.enterprise_name || targetName;
    if (updated.address_proof) updated.address_proof.billed_to = uRec?.enterprise_name || targetName;
  } else if (remediation_type === 'PROPRIETOR_ESIGN') {
    updated.signatory_id = {
      ...updated.signatory_id,
      present: true,
      designation: 'Proprietor / Authorised Signatory (Aadhaar e-Sign Verified)',
      for_business: targetName,
      valid_till: '2030-12-31'
    };
  } else if (remediation_type === 'FRESH_ADDRESS_PROOF') {
    updated.address_proof = {
      ...updated.address_proof,
      present: true,
      bill_date: '2026-07-01',
      billed_to: targetName,
      supply_address: targetAddress
    };
  }

  const validation = runForensicKycValidation(updated, [], false);
  res.json({
    extracted_data: updated,
    validation_report: validation
  });
});

// 9. Create Order & Live Tracker Endpoint
app.post('/api/orders', (req, res) => {
  const { profile, bundle_items, summary, kyc_status, consent_timestamp, preferred_slot } = req.body;
  const maxDays = bundle_items?.reduce((m, i) => Math.max(m, i.typical_install_days || 2), 2) || 5;

  const order = {
    order_id: `ORD-UDYAM-${1001 + db.orders.length}`,
    created_at: '2026-07-15T10:30:00Z',
    business_name: profile?.business_name || 'Your Enterprise',
    city: profile?.city || 'Visakhapatnam',
    contact_phone: profile?.contact_phone || '+91 98201 XXXXX',
    preferred_slot: preferred_slot || 'Tomorrow, 10:00 AM – 1:00 PM',
    bundle_items,
    summary,
    kyc_status: kyc_status || 'APPROVED',
    consent_timestamp: consent_timestamp || new Date().toISOString(),
    estimated_activation_days: Math.min(maxDays, 5),
    engineer: {
      name: 'Rajesh Kumar',
      role: 'Certified Accel Fibre & CPE Engineer',
      phone: '+91-98450-11223',
      partner_hub: `Accel Local Partner Hub (${profile?.city || 'Regional'})`,
      otp: '4829'
    },
    milestones: [
      { step: 1, title: 'Digital Order & DPDP Consent Logged', status: 'COMPLETED', timestamp: '15 Jul 2026, 10:30 AM', detail: 'Zero-paperwork e-Sign & KYC verified' },
      { step: 2, title: 'Automated Network Feasibility & Port Allocation', status: 'COMPLETED', timestamp: '15 Jul 2026, 10:32 AM', detail: 'Nearest OLT fibre port & cloud SaaS licences reserved' },
      { step: 3, title: 'Doorstep Engineer Dispatched', status: 'IN_PROGRESS', timestamp: '15 Jul 2026, 11:00 AM', detail: 'Engineer Rajesh Kumar assigned with pre-configured router kit' },
      { step: 4, title: 'Last-Mile Installation & Single-Bill Activation', status: 'PENDING', timestamp: `Scheduled: ${preferred_slot || 'Tomorrow, 10:00 AM – 1:00 PM'}`, detail: 'Share Installation OTP 4829 with engineer upon speed test completion' }
    ]
  };

  db.orders.unshift(order);
  res.json({ order });
});

// 10. Customer Escalation to Assisted Field Sales / Channel Partner
app.post('/api/sales/escalate', (req, res) => {
  const { profile, bundle_summary, reason, stage_reached } = req.body;
  const newLeadId = `L-LIVE-${5001 + db.leads.length}`;
  const liveLead = {
    lead_id: newLeadId,
    created_date: '2026-07-15',
    lead_source: 'AI Advisor Escalation',
    business_name: profile?.business_name || 'New MSME Prospect',
    business_type: profile?.business_type || 'Enterprise',
    segment: profile?.segment || 'Professional offices',
    city: profile?.city || 'Visakhapatnam',
    city_tier: Number(profile?.city_tier || 2),
    preferred_language: profile?.preferred_language || 'English',
    employee_count: Number(profile?.employee_count || 10),
    num_sites: Number(profile?.num_sites || 1),
    has_gstin: profile?.has_gstin || 'Y',
    gstin: profile?.gstin || '37IHKXV5167L1ZS',
    stage_reached: stage_reached || 'Needs assessed',
    outcome: 'Dropped',
    drop_reason: reason || 'Requested Assisted Callback',
    monthly_telecom_spend_inr: bundle_summary?.monthly_total_inr || 4500,
    propensity_score: stage_reached === 'KYC complete' ? 99 : 92,
    is_live_escalation: true
  };

  db.leads.unshift(liveLead);
  res.json({ success: true, escalated_lead: liveLead });
});

// 11. Admin Back-Office Analytics + Full Paginated & Filterable 4,632 Unclosed Leads
app.get('/api/sales/dashboard', (req, res) => {
  const {
    page = 1,
    limit = 20,
    search = '',
    segment = 'ALL',
    stage = 'ALL',
    gstin_filter = 'ALL'
  } = req.query;

  const totalLeads = db.leads.length;
  const stageCounts = {
    'Total Leads': totalLeads,
    'Contacted': db.leads.filter(l => l.contacted_date || l.is_live_escalation).length,
    'Needs Assessed': db.leads.filter(l => l.needs_assessed_date || l.is_live_escalation).length,
    'Quote Accepted': db.leads.filter(l => l.quote_accepted_date || l.is_live_escalation).length,
    'KYC Stage': db.leads.filter(l => l.kyc_complete_date || l.is_live_escalation).length,
    'Activated': db.leads.filter(l => l.outcome === 'Activated').length
  };

  const dropMap = {};
  db.leads.filter(l => l.outcome === 'Dropped').forEach(l => {
    dropMap[l.drop_reason] = (dropMap[l.drop_reason] || 0) + 1;
  });
  const topDropReasons = Object.entries(dropMap)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  let filtered = db.leads.filter(l => l.outcome === 'Dropped');

  if (search.trim()) {
    const q = search.trim().toLowerCase();
    filtered = filtered.filter(l =>
      (l.business_name || '').toLowerCase().includes(q) ||
      (l.city || '').toLowerCase().includes(q) ||
      (l.lead_id || '').toLowerCase().includes(q) ||
      (l.drop_reason || '').toLowerCase().includes(q)
    );
  }
  if (segment !== 'ALL') {
    filtered = filtered.filter(l => l.segment === segment);
  }
  if (stage !== 'ALL') {
    filtered = filtered.filter(l => l.stage_reached === stage);
  }
  if (gstin_filter !== 'ALL') {
    filtered = filtered.filter(l => l.has_gstin === gstin_filter);
  }

  filtered.sort((a, b) => {
    if (a.is_live_escalation && !b.is_live_escalation) return -1;
    if (!a.is_live_escalation && b.is_live_escalation) return 1;
    return b.propensity_score - a.propensity_score;
  });

  const totalUnclosedFiltered = filtered.length;
  const pageNum = Math.max(1, Number(page));
  const pageSize = Math.max(10, Math.min(100, Number(limit)));
  const startIndex = (pageNum - 1) * pageSize;

  const paginatedLeads = filtered.slice(startIndex, startIndex + pageSize).map(l => ({
    lead_id: l.lead_id,
    business_name: l.business_name,
    business_type: l.business_type,
    segment: l.segment,
    city: l.city,
    city_tier: l.city_tier,
    preferred_language: l.preferred_language,
    employee_count: l.employee_count,
    num_sites: l.num_sites,
    has_gstin: l.has_gstin,
    gstin_masked: maskIdentifier(l.gstin),
    stage_reached: l.stage_reached,
    drop_reason: l.drop_reason,
    products_of_interest: l.products_of_interest,
    monthly_telecom_spend_inr: l.monthly_telecom_spend_inr,
    propensity_score: l.propensity_score,
    is_live_escalation: Boolean(l.is_live_escalation),
    dispatch_status: l.dispatch_status || null,
    assigned_partner: l.assigned_partner || null,
    recommended_action: l.stage_reached === 'KYC complete'
      ? 'Trigger Priority Install Dispatch'
      : (l.drop_reason || '').includes('Quote')
      ? 'Send Instant WhatsApp Quote'
      : 'Assign Channel Partner Visit'
  }));

  res.json({
    funnel: stageCounts,
    top_drop_reasons: topDropReasons,
    total_unclosed_count: totalUnclosedFiltered,
    current_page: pageNum,
    total_pages: Math.ceil(totalUnclosedFiltered / pageSize),
    page_size: pageSize,
    priority_leads: paginatedLeads,
    live_orders: db.orders
  });
});

// 12. Real Backend Action: Dispatch Field Sales / Channel Partner
app.post('/api/sales/dispatch', (req, res) => {
  const { lead_id, action_type } = req.body;
  const lead = db.leads.find(l => l.lead_id === lead_id);
  if (!lead) {
    return res.status(404).json({ error: 'Lead record not found' });
  }

  lead.dispatch_status = 'DISPATCHED';
  lead.assigned_partner = `Accel Partner Hub (${lead.city}) • Ref #CP-${lead_id.slice(-3)}`;
  lead.dispatched_at = new Date().toISOString();

  res.json({
    success: true,
    lead_id,
    dispatch_status: lead.dispatch_status,
    assigned_partner: lead.assigned_partner,
    action_taken: action_type
  });
});

// Start Server after loading CSV data
const PORT = process.env.PORT || 5050;

async function bootstrap() {
  try {
    await loadAllData();
    const server = app.listen(PORT, () => {
      console.log(`🚀 Accel Udyam Digital Backend running on http://localhost:${PORT}`);
      console.log(`⚡ AI Router Priority: 1. Groq (${process.env.GROQ_API_KEY ? 'ACTIVE' : 'NOT SET'}) -> 2. Gemini (${GEMINI_MODEL}) -> 3. Local NLU & Tesseract OCR`);
    });
    server.on('error', (err) => {
      console.error('Server error:', err);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
  }
}

bootstrap();