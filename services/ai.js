/* * ai_medical_summary_service.js
 * - REFATOR for Hugging Face Inference API and the specified MedGemma model.
 * - MODEL NAME UPDATED to 'google/medgemma-27b-it'
 * - Integrated HEALTH_REPORT_ANALYST_SYSTEM_PROMPT.
 * - FIX APPLIED: Removed reportId and structural markers from the prompt content.
 * * NOTE: This relies on a HUGGINGFACE_API_KEY environment variable. Performance will be slow
 * and potentially hit rate limits on the standard Hugging Face Inference API.
 */

const { db } = require('../config/firebase'); // keep your existing firebase config path

// Optional validator (AJV). If not installed, code still works with a lightweight fallback.
let ajv = null;
try { ajv = require('ajv')(); } catch (e) { /* ajv not installed, we'll fallback to basic checks */ }

// --- Hugging Face Configuration ---
const MODEL_NAME = 'google/medgemma-27b-text-it'; // <-- UPDATED to 27B
// const API_URL = `https://api-inference.huggingface.co/models/${MODEL_NAME}`;
const API_URL = `https://router.huggingface.co/hf-inference/models/${MODEL_NAME}`;

const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY;

// --- API Constants ---
const DEFAULT_BATCH_SIZE = 5; 
const MAX_SUGGESTIONS_REPORTS = 5; 
const API_CALL_TIMEOUT_MS = 30000; // Increased timeout for larger HF models
const MODEL_CALL_RETRIES = 2;

// ------------------ Integrated System Prompt ------------------
const HEALTH_REPORT_ANALYST_SYSTEM_PROMPT = `
You are an expert Health Report Analyst AI whose job is to extract, analyze, and synthesize clinical data from medical documents into a single, strict JSON object.

IMPORTANT: Under NO CIRCUMSTANCES produce diagnoses, prescribe treatment, give medical advice, or make clinical decisions. Your output MUST be purely observational and derived only from the provided document text/numbers.

--------------------------
OPERATIONAL RULES (must follow)
--------------------------
1) Output format
  - Return ONE single JSON object only. No explanations, no markdown, no extra text.
  - The JSON must conform to the responseSchema supplied by the calling API. If the API provides a schema, ensure the JSON keys and types match exactly.
  - Include a top-level key "schemaVersion" (string) to indicate the prompt/schema version used, e.g. "v1.0".

2) Extraction expectations
  - Identify every measurable lab/test result present (e.g., Glucose, Hemoglobin A1c, LDL, TSH, Hemoglobin).
  - For each result capture these fields (if available): testName, measuredValue (numeric where possible), rawValue (original text), units, referenceRangeRaw, referenceRangeParsed, status, critical (boolean), reportDate, reportId (if present), and comments (free text observations about parsing).
  - If the numeric value cannot be reliably parsed, set measuredValue to null and status to "PENDING".

3) Numeric parsing rules (be conservative)
  - Remove thousands separators (commas) and parse decimal points.
  - Accept numeric forms like "105", "6.2", "130.5", "1.2e2".
  - Handle relational prefixes: "<5.7" or "≤5.7" (treat rawValue = "<5.7", measuredValue = 5.7 with a flag that it is an upper bound); similarly for ">", "≥".
  - For ranges inside the value column (e.g., "4.5 - 5.4"), prefer treating as ambiguous: measuredValue = null, store rawValue, and status = "PENDING".
  - Non-numeric qualifiers like "trace", "negative", "not detected" → measuredValue = null, status = "PENDING".

4) Reference range parsing
  - Parse common range formats: "70-100 mg/dL", "< 5.7 %", ">= 40", "Up to 120", "Normal: 0.5–4.5".
  - If a lower and upper bound exist, store referenceRangeParsed = { low: <number|null>, high: <number|null> }.
  - If only a single comparative limit exists (e.g., "< 5.7"), set low = null, high = number.
  - If unable to parse, set referenceRangeParsed = { low: null, high: null } and referenceRangeConfidence = 0.

5) Status assignment (deterministic)
  - If measuredValue is numeric and referenceRangeParsed has both low and high:
      * measuredValue < low  => status = "LOW"
      * measuredValue > high => status = "HIGH"
      * low <= measuredValue <= high => status = "NORMAL"
  - If referenceRangeParsed has only one bound:
      * If only high bound and measuredValue > high => "HIGH", else if numeric and <= high => "NORMAL"
      * If only low bound and measuredValue < low => "LOW", else if numeric and >= low => "NORMAL"
  - If measuredValue is null or parsing uncertain => status = "PENDING"
  - CRITICAL: mark critical = true only when deviation is large (see Critical criteria below). Use sparingly.

6) Critical criteria (conservative)
  - Use CRITICAL only for clear, large deviations:
      * If both low & high exist and measuredValue is numeric:
          - If measuredValue >= high * 1.5 OR measuredValue <= low * 0.5 → critical = true
      * If only single-bound exists and numeric value deviates beyond 50% of that bound in the dangerous direction → critical = true
  - If you cannot determine numeric magnitude reliably, set critical = false and status = "PENDING".
  - ALWAYS set a short comment explaining why critical was set (e.g., "Value is 160, which is > 1.5× upper bound 100").

7) Confidence scoring (0.0 - 1.0)
  - Provide an overall "confidence" number between 0.0 and 1.0 representing your confidence in the correctness of the extraction and parsing.
  - Also provide "confidenceBreakdown" with numeric 0.0-1.0 scores for: legibility, valueParsing, rangeParsing, unitParsing, mappingToTestName.
  - Compute overall confidence conservatively as the minimum or weighted average (choose a clear approach) and include your method in "parsingNotes".

8) Document-level synthesis
  - identifiedPanels: array of recognized test groups (e.g., ["CBC", "Lipid Panel"]) — only what can be confidently inferred.
  - priorityEmoji: one of ["✅","⚠️","🚨"] based on presence of CRITICAL (🚨), non-critical HIGH/LOW (⚠️), or all NORMAL/PENDING (✅).
  - overallSummary: one short paragraph (<=3 sentences) explaining the main observations in patient-friendly language — no advice or instructions.
  - criticalSummary: a single short phrase for the most urgent observation or empty string if none.

9) Educational & non-medical suggestions
  - suggestedLifestyleFocus: list of broad focus areas (e.g., ["Heart health", "Hydration"]) based strictly on observed HIGH/LOW values.
  - educationSearchTerms: list of keywords/phrases the user can search to learn more (non-diagnostic), e.g., ["what causes high LDL", "understanding TSH results"].

10) Error handling & strict output rules
  - If you cannot find any measurable results, return findings: [] and include an explanation in parsingNotes. Do not fabricate any tests.
  - All date fields must be ISO-8601 (YYYY-MM-DD) or "Not Found".
  - Provide "parsingNotes" (string) summarizing ambiguous items or redactions performed.
  - If you redacted or masked PHI in the input, add a boolean field "phiRedacted": true and list which elements were redacted in parsingNotes.

11) Safety and hallucination prevention
  - Do NOT invent reference ranges, units, or tests. If missing, mark as 'N/A' or null and set status to "PENDING".
  - Do NOT assume patient identity or infer clinical context beyond the document.
  - When uncertain, prefer "PENDING" and include explanatory text in parsingNotes.

--------------------------
RESPONSE OBJECT: REQUIRED FIELDS
--------------------------
Return a single JSON object with at least these keys (the calling code may require a schema provided via the API; ensure fields align):

{
  "schemaVersion": "v1.0",
  "reportId": "<string or null>",
  "reportDate": "<YYYY-MM-DD or 'Not Found'>",
  "confidence": 0.0,
  "confidenceBreakdown": {
    "legibility": 0.0,
    "valueParsing": 0.0,
    "rangeParsing": 0.0,
    "unitParsing": 0.0,
    "mappingToTestName": 0.0
  },
  "findings": [
    {
      "testName": "string",
      "measuredValue": 0.0,        // numeric or null
      "rawValue": "original text",
      "units": "string or 'N/A'",
      "referenceRangeRaw": "string or 'N/A'",
      "referenceRangeParsed": { "low": null, "high": null },
      "status": "NORMAL|HIGH|LOW|PENDING",
      "critical": false,
      "comments": "parsing notes specific to this finding"
    }
  ],
  "identifiedPanels": ["array of strings"],
  "priorityEmoji": "✅|⚠️|🚨",
  "overallSummary": "patient-friendly paragraph",
  "criticalSummary": "short phrase or empty",
  "suggestedLifestyleFocus": ["array of broad topics"],
  "educationSearchTerms": ["array of strings"],
  "parsingNotes": "human-readable short notes about parsing, ambiguities, redactions",
  "phiRedacted": false
}

--------------------------
FINAL NOTE
--------------------------
Return ONLY the single JSON object that follows the response schema. If the caller provides a responseSchema via the model API, strictly adhere to that schema. If any mandatory field cannot be produced, set it to null or 'Not Found' and explain in parsingNotes.
`;

// ------------------ End of integrated prompt ------------------

// Simple PHI redaction helper (lightweight). Tailor to your needs.
function redactPHI(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  // redact email-like patterns
  out = out.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]');
  // redact phone-like sequences (very naive)
  out = out.replace(/\b\d{10}\b/g, '[REDACTED_PHONE]');
  out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]');
  // redact simple full name patterns (Two capitalized words) - may be noisy, adapt as needed
  out = out.replace(/\b([A-Z][a-z]+\s+[A-Z][a-z]+)\b/g, '[REDACTED_NAME]');
  // redact long numbers (MRNs)
  out = out.replace(/\b\d{6,}\b/g, '[REDACTED_ID]');
  return out;
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

async function withRetries(fn, options = {}) {
  const retries = options.retries ?? MODEL_CALL_RETRIES;
  const initial = options.initialDelay ?? 500;
  let attempt = 0;
  while (true) {
    try { return await fn(); }
    catch (err) {
      if (attempt >= retries) throw err;
      const delay = initial * Math.pow(2, attempt);
      await sleep(delay);
      attempt++;
    }
  }
}

// --- Hugging Face Inference API client ---
async function huggingFaceInference(fullPrompt, timeoutMs = API_CALL_TIMEOUT_MS) {
  if (!HUGGINGFACE_API_KEY) throw new Error('Hugging Face API key not configured (HUGGINGFACE_API_KEY)');

  // Use a timeout controller for the fetch request
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HUGGINGFACE_API_KEY}`,
      },
      body: JSON.stringify({
        // MedGemma is an instruction-tuned model, we package the prompt as a single instruction.
        inputs: fullPrompt,
        parameters: {
          return_full_text: false, // Only return the generated text
          max_new_tokens: 4096,
          temperature: 0.1, // Low temperature for deterministic output
          do_sample: false, // Prefer greedy decoding
          use_cache: true
        },
        options: {
          wait_for_model: true // Wait for the model to load if it's currently unloaded (can take a long time for 27B)
        }
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Hugging Face API Error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    
    // HF Inference API usually returns an array of results
    if (Array.isArray(data) && data.length > 0 && data[0].generated_text) {
        return data[0].generated_text.trim();
    }
    
    throw new Error('Hugging Face API returned an unexpected response format.');

  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Model call timed out');
    }
    throw error;
  }
}

// Adapts the old Google AI SDK call structure to the new Hugging Face client
async function callModel(promptOptions, timeoutMs = API_CALL_TIMEOUT_MS) {
  const systemInstruction = promptOptions.systemInstruction.parts[0].text;
  const userPrompt = promptOptions.contents[0].parts[0].text;
  
  // Format the prompt for instruction-following models (e.g., using a simple instruction pattern)
  const fullPrompt = `System Instruction: ${systemInstruction}\n\nUser Request: ${userPrompt}`;

  return withRetries(() => huggingFaceInference(fullPrompt, timeoutMs), { retries: MODEL_CALL_RETRIES });
}
// --- END Hugging Face Inference API client ---


function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function safeTrim(text, n) {
  if (!text) return text || '';
  return text.length > n ? text.substring(0, n) + '...' : text;
}

// Basic JSON extraction for arrays or objects inside model output
function extractJsonFromText(text) {
  if (!text || typeof text !== 'string') return null;
  // try common fenced JSON
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced && fenced[1]) {
    try { return JSON.parse(fenced[1]); } catch (e) { /* fallthrough */ }
  }
  // try to find first {...} or [...] block
  const firstArray = text.match(/\[[\s\S]*\]/);
  if (firstArray) {
    try { return JSON.parse(firstArray[0]); } catch (e) { /* fallthrough */ }
  }
  const firstObj = text.match(/\{[\s\S]*\}/);
  if (firstObj) {
    try { return JSON.parse(firstObj[0]); } catch (e) { /* fallthrough */ }
  }
  return null;
}

// Lightweight validation fallback if ajv not present
function basicValidateSuggestions(arr) {
  if (!Array.isArray(arr)) return false;
  for (const item of arr) {
    if (!item || typeof item !== 'object') return false;
    if (!item.title || !item.description) return false;
    // priority fallback
    if (item.priority && !['high','medium','low'].includes(String(item.priority))) return false;
  }
  return true;
}

// Suggestion schema for AJV (if present)
const suggestionsSchema = {
  type: 'array',
  items: {
    type: 'object',
    required: ['type','title','description','priority'],
    properties: {
      type: { type: 'string', enum: ['lifestyle','diet','follow_up','preventive','wellness'] },
      title: { type: 'string' },
      description: { type: 'string' },
      priority: { type: 'string', enum: ['high','medium','low'] },
      sourceReportId: { type: 'string' }
    }
  }
};
let validateSuggestions = null;
if (ajv) validateSuggestions = ajv.compile(suggestionsSchema);

// ---------- Public functions ----------

/**
 * generateSummary(userId)
 * - Fetches user's reports.
 * - Redacts PHI from content before sending to model.
 * - Summarizes in batches and combines into a final patient-friendly summary.
 * - Fix: Removes internal reportId from text sent to model.
 */
/**
 * Generate AI summary for specific report IDs
 * @param {Array<string>} reportIds - Array of report IDs to summarize
 * @returns {Promise<{summary: string, generatedAt: string, reportCount: number}>}
 */
async function generateSummaryForReports(reportIds) {
  if (!HUGGINGFACE_API_KEY) throw new Error('Hugging Face API key not configured');
  if (!reportIds || !Array.isArray(reportIds) || reportIds.length === 0) {
    throw new Error('Invalid reportIds');
  }

  try {
    // Fetch specific reports by IDs
    const reportDocs = await Promise.all(
      reportIds.map(id => db.collection('reports').doc(id).get())
    );

    const reports = reportDocs
      .filter(doc => doc.exists)
      .map(doc => ({ reportId: doc.id, ...(doc.data() || {}) }))
      .sort((a, b) => {
        // Sort by reportDate descending
        const dateA = a.reportDate?.toDate ? a.reportDate.toDate() : new Date(a.reportDate || 0);
        const dateB = b.reportDate?.toDate ? b.reportDate.toDate() : new Date(b.reportDate || 0);
        return dateB - dateA;
      });

    if (reports.length === 0) {
      return {
        summary: 'No medical reports found.',
        generatedAt: new Date().toISOString(),
        reportCount: 0
      };
    }

    const reportCount = reports.length;

    // If many reports, do progressive summarization
    const batches = chunkArray(reports, DEFAULT_BATCH_SIZE);
    const batchSummaries = [];

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      const batchText = batch.map((r, i) => {
        const rawContent = r.summary || r.extractedText || '';
        const safe = redactPHI(rawContent);
        // FIX APPLIED: Removed r.reportId from the prompt content
        return `--- Report ${i + 1} (Date: ${r.reportDate || 'N/A'}) ---\nCategory: ${r.category || 'General'}\nTitle: ${r.title || 'Untitled'}\nContent Preview:\n${safe}\n--- End of Report ${i + 1} ---`;
      }).join('\n\n');

      const prompt = `You are a careful, analytical medical AI assistant.\n\nFor the reports below, produce a concise bullet-list of the most important observations (3-6 bullets) and a single one-sentence patient-friendly takeaway. Do NOT provide diagnoses or medical advice; remain observational. Return plain text only.\n\n${batchText}`;

      const modelResp = await callModel({
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: HEALTH_REPORT_ANALYST_SYSTEM_PROMPT }] }
      });

      batchSummaries.push(safeTrim(modelResp || '', 2000));
    }

    // Combine batch summaries into final summary
    const combinePrompt = `You are a medical AI assistant. Combine the following batch summaries into: (1) a 3-5 sentence plain-language overview suitable for a patient, (2) a bulleted list of key findings, and (3) 3 short non-prescriptive next steps (e.g., "consider discussing X with your clinician"). Do NOT diagnose.\n\nBatch Summaries:\n${batchSummaries.join('\n\n---\n\n')}`;

    const finalResp = await callModel({
      contents: [{ parts: [{ text: combinePrompt }] }],
      systemInstruction: { parts: [{ text: HEALTH_REPORT_ANALYST_SYSTEM_PROMPT }] }
    });

    const summary = finalResp || 'Unable to generate summary at this time.';

    return { summary, generatedAt: new Date().toISOString(), reportCount };
  }
  catch (err) {
    console.error('generateSummaryForReports error:', err);
    return { summary: 'Unable to generate AI summary at this time. Please try again later.', generatedAt: new Date().toISOString(), reportCount: 0 };
  }
}

async function generateSummary(userId) {
  if (!HUGGINGFACE_API_KEY) throw new Error('Hugging Face API key not configured');
  if (!userId || typeof userId !== 'string') throw new Error('Invalid userId');

  try {
    const snapshot = await db.collection('reports')
      .where('userId', '==', userId)
      .orderBy('reportDate', 'desc')
      .get();

    if (snapshot.empty) {
      return {
        summary: 'No medical reports found. Upload reports to get personalized health insights.',
        generatedAt: new Date().toISOString(),
        reportCount: 0,
        lastReportDate: null
      };
    }

    const reports = snapshot.docs.map(d => ({ reportId: d.id, ...(d.data() || {}) }));
    const reportCount = reports.length;
    const lastReportDate = reports[0].reportDate || null;

    // If many reports, do progressive summarization
    const batches = chunkArray(reports, DEFAULT_BATCH_SIZE);
    const batchSummaries = [];

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      const batchText = batch.map((r, i) => {
        const rawContent = r.summary || r.extractedText || '';
        const safe = redactPHI(rawContent);
        // FIX APPLIED: Removed r.reportId from the prompt content
        return `--- Report ${i + 1} (Date: ${r.reportDate || 'N/A'}) ---\nCategory: ${r.category || 'General'}\nTitle: ${r.title || 'Untitled'}\nContent Preview:\n${safe}\n--- End of Report ${i + 1} ---`;
      }).join('\n\n');

      const prompt = `You are a careful, analytical medical AI assistant.\n\nFor the reports below, produce a concise bullet-list of the most important observations (3-6 bullets) and a single one-sentence patient-friendly takeaway. Do NOT provide diagnoses or medical advice; remain observational. Return plain text only.\n\n${batchText}`;

      const modelResp = await callModel({
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: HEALTH_REPORT_ANALYST_SYSTEM_PROMPT }] }
      });

      batchSummaries.push(safeTrim(modelResp || '', 2000));
    }

    // Combine batch summaries into final summary
    const combinePrompt = `You are a medical AI assistant. Combine the following batch summaries into: (1) a 3-5 sentence plain-language overview suitable for a patient, (2) a bulleted list of key findings, and (3) 3 short non-prescriptive next steps (e.g., "consider discussing X with your clinician"). Do NOT diagnose.\n\nBatch Summaries:\n${batchSummaries.join('\n\n---\n\n')}`;

    const finalResp = await callModel({
      contents: [{ parts: [{ text: combinePrompt }] }],
      systemInstruction: { parts: [{ text: HEALTH_REPORT_ANALYST_SYSTEM_PROMPT }] }
    });

    const summary = finalResp || 'Unable to generate summary at this time.';

    return { summary, generatedAt: new Date().toISOString(), reportCount, lastReportDate };
  }
  catch (err) {
    console.error('generateSummary error:', err);
    return { summary: 'Unable to generate AI summary at this time. Please try again later.', generatedAt: new Date().toISOString(), reportCount: 0, lastReportDate: null };
  }
}

/**
 * generateSuggestions(userId, reportId?)
 * - For a single report: produce JSON array of suggestions
 * - For multiple reports: aggregate up to MAX_SUGGESTIONS_REPORTS recent reports
 * - Validates JSON via AJV when available; falls back to conservative parsing
 * - Fix: Removes internal reportId from text sent to model.
 */
async function generateSuggestions(userId, reportId = null) {
  if (!HUGGINGFACE_API_KEY) throw new Error('Hugging Face API key not configured');
  if (!userId || typeof userId !== 'string') throw new Error('Invalid userId');

  try {
    let reports = [];

    if (reportId) {
      const doc = await db.collection('reports').doc(reportId).get();
      if (!doc.exists) return { suggestions: [], generatedAt: new Date().toISOString(), reportId };
      const data = doc.data();
      if (!data || data.userId !== userId) throw new Error('Unauthorized or no data');
      reports = [{ reportId: doc.id, ...data }];
    } else {
      const snap = await db.collection('reports')
        .where('userId', '==', userId)
        .orderBy('reportDate', 'desc')
        .limit(MAX_SUGGESTIONS_REPORTS)
        .get();
      if (!snap.empty) reports = snap.docs.map(d => ({ reportId: d.id, ...(d.data() || {}) }));
    }

    if (!reports.length) return { suggestions: [], generatedAt: new Date().toISOString(), ...(reportId ? { reportId } : {}) };

    const promptReports = reports.map((r, i) => {
      const raw = r.summary || r.extractedText || '';
      const safe = redactPHI(raw);
      // FIX APPLIED: Removed r.reportId from the prompt content
      return `--- Report ${i + 1} (Date: ${r.reportDate || 'N/A'}) ---\nCategory: ${r.category || 'General'}\nTitle: ${r.title || 'Untitled'}\nContent:\n${safe}\n--- End of Report ${i + 1} ---`;
    }).join('\n\n');

    const userPrompt = reportId
      ? `Based specifically on the following single medical report, produce a JSON array of practical, non-diagnostic, patient-facing suggestions. Each suggestion must contain: type (lifestyle|diet|follow_up|preventive|wellness), title, description, priority (high|medium|low). Return ONLY valid JSON (no markdown or explanatory text).\n\n${promptReports}`
      : `Based on the following medical reports, produce a JSON array of practical, non-diagnostic, patient-facing suggestions that address recurring themes or notable findings. Each suggestion must contain: type (lifestyle|diet|follow_up|preventive|wellness), title, description, priority (high|medium|low). Return ONLY valid JSON (no markdown or explanatory text).\n\n${promptReports}`;

    const modelResp = await callModel({
      contents: [{ parts: [{ text: userPrompt }] }],
      systemInstruction: { parts: [{ text: HEALTH_REPORT_ANALYST_SYSTEM_PROMPT }] }
    });

    const parsed = extractJsonFromText(modelResp);
    let suggestions = null;

    if (parsed) {
      // Validate using AJV if available
      if (validateSuggestions) {
        const valid = validateSuggestions(parsed);
        if (valid) suggestions = parsed;
        else {
          console.warn('AJV validation errors:', validateSuggestions.errors);
        }
      } else {
        if (basicValidateSuggestions(parsed)) suggestions = parsed;
      }
    }

    // If parsing/validation failed, fall back to conservative single suggestion
    if (!suggestions) {
      suggestions = [{
        type: 'wellness',
        title: 'AI generated suggestions (unstructured)',
        description: safeTrim(modelResp || 'No suggestions generated', 1000),
        priority: 'medium',
        sourceReportId: reportId || undefined
      }];
    } else {
      // Normalize items and ensure required fields exist
      suggestions = suggestions.map(s => ({
        type: (s.type || 'wellness'),
        title: String(s.title || 'Suggestion'),
        description: String(s.description || ''),
        priority: (s.priority || 'medium'),
        sourceReportId: s.sourceReportId || (reportId || undefined) 
      }));
    }

    return { ...(reportId ? { reportId } : {}), suggestions, generatedAt: new Date().toISOString() };
  }
  catch (err) {
    console.error('generateSuggestions error:', err);
    return { ...(reportId ? { reportId } : {}), suggestions: [{ type: 'wellness', title: 'Failed to Generate Suggestions', description: 'An unexpected error occurred. Please try again later.', priority: 'low' }], generatedAt: new Date().toISOString() };
  }
}

module.exports = { generateSummary, generateSuggestions, generateSummaryForReports };
