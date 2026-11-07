# Project Udyam Digital - Accel Business (Airtel SYNC Hackathon 2026)

**[ Watch our Project Demo on YouTube here](YOUR_YOUTUBE_VIDEO_LINK_HERE)**

**AI-First MSME Acquisition, Automated Forensic e-KYC & Zero-Touch Provisioning Platform**  
**Team Name:** Team Rannchhoddas!  
**Team Members:** Srijan Agrawal, Shriyansh Pandey  
**Institution:** National Institute of Technology (NIT) Raipur  

---

## 1. Overview & Problem Solved
Accel Business handles **5,000 SMB inquiries per quarter**, yet only **368 convert to active connections (7.36% conversion)** at a blended acquisition cost of **₹15,053 per activated SMB** and an average activation time of **17.6 days**.

**Project Udyam Digital** replaces this fragmented, paper-heavy funnel with a dual-portal digital platform:
1. **Customer Self-Serve Onboarding App:**
   - **Multilingual AI Solution Advisor (`Udyam Sahayak`):** Supports **English, Hindi, Hinglish, Marathi, Tamil, and Telugu** with Web Speech API voice input and strict B2B domain guardrails.
   - **Deterministic Bundle & Dependency Engine (`bundleEngine.js`):** Evaluates all 25 products in `product_catalogue.csv` against city tiers (`Tier 1` vs `Tier 2`), employee count, site count, GSTIN requirements (`requires_gstin == 'Y'`), and product dependency graphs (`requires_one_of`) with zero price hallucinations.
   - **Smart Forensic e-KYC (`kycValidator.js`):** Parallel multi-core OCR (`~2 seconds`) with a 0-cost Pre-Flight Completeness Gate, Mod-36 GSTIN checksum & tamper detection, positional OCR de-noising, 90-day utility bill recency check (Ref Date: `2026-07-15`), signatory authority verification, and **1-Click Self-Serve Remediation via DigiLocker / Aadhaar OTP e-Sign**.
   - **Zero-Call Service Provisioning Tracker:** 4-stage live installation tracker with assigned local channel partner engineer details, slot scheduling, and completion OTP (`4829`).
2. **Internal Staff & Channel Partner Back-Office Portal:**
   - Full funnel drop-off diagnostics across all 5,000 leads.
   - **AI Propensity Recovery Queue (`0–99` Score):** Searchable, filterable, paginated queue across all **4,632 unclosed leads** + live customer escalations (`LIVE ESCALATION`), with 1-click partner dispatch.

---

## 2. Solution Architecture
- **Frontend:** React 19, Vite, Tailwind CSS, Lucide Icons, Web Speech API
- **Backend:** Node.js, Express.js (`v5.3`), Multer, Tesseract.js (Parallel Multi-Core OCR)
- **Multi-Tier AI Routing:**
  - **Priority #1:** Groq Cloud LPU API (Auto-discovered active model, `<0.5s` latency)
  - **Priority #2:** Google Gemini (`gemini-3.8-flash`)
  - **Priority #3:** Local Grounded NLU & Parallel Tesseract OCR Engine (`100%` offline uptime)
- **Data Layer:** In-Memory `O(1)` Hash Maps (`product_catalogue.csv`, `mock_gstin_registry.csv`, `mock_udyam_registry.csv`, `smb_leads.csv`)

---

## 3. DPDP Act, 2023 Privacy & Security Note
1. **Explicit Notice & Affirmative Consent (Sec. 5 & 6):** Customers must accept an explicit purpose-bound consent notice before KYC document processing begins; consent timestamps are logged with every order.
2. **Data Minimisation:** Step 1 (Needs Discovery) collects zero PII. Step 2 processes only the 4 mandatory B2B onboarding proofs in memory.
3. **Identifier Masking & Pseudonymisation:** All GSTIN and Udyam numbers are dynamically masked (`37IH•••••••1ZS`) across UI views, API payloads, and back-office tables.
4. **Storage Limitation & 30-Day Auto-Purge (Sec. 8(7)):** Raw document images are scheduled for automated deletion 30 days post-activation, retaining only immutable verification status logs.

---

## 4. Quick Start & Local Setup

### Prerequisites
- Node.js `v18+` installed

### 1. Start the Backend Server (`Port 5050`)
```bash
cd backend
npm install
```

Create a `.env` file inside `backend/` (the app also runs 100% offline via Priority #3 Local NLU & Parallel Tesseract OCR):
```env
PORT=5050
GROQ_API_KEY=your_groq_api_key_here
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-3.8-flash
```

Run the backend:
```bash
npm run dev
```

### 2. Start the Frontend Application (Port 5173)
Open a second terminal:
```bash
cd frontend
npm install
npm run dev
```
Open http://localhost:5173 in your browser.