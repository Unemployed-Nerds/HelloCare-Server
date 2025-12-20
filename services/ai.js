/* * ai_medical_summary_service.js
 * - Refactored for Google Gemini API
 * - Integrated HEALTH_REPORT_ANALYST_SYSTEM_PROMPT.
 * - FIX APPLIED: Removed reportId and structural markers from the prompt content.
 * * NOTE: This relies on a GEMINI_API_KEY environment variable.
 */

const { db } = require('../config/firebase'); // keep your existing firebase config path
const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');

// Optional validator (AJV). If not installed, code still works with a lightweight fallback.
let ajv = null;
try { ajv = require('ajv')(); } catch (e) { /* ajv not installed, we'll fallback to basic checks */ }

// --- Google Gemini Configuration ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL_NAME = 'gemini-2.5-flash'; // Using Gemini 3.0 Pro (latest stable model)

// Initialize Gemini client
let genAI = null;
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
}

// --- API Constants ---
const DEFAULT_BATCH_SIZE = 5; 
const MAX_SUGGESTIONS_REPORTS = 5; 
const API_CALL_TIMEOUT_MS = 60000; // Increased timeout to 60 seconds for complex summaries
const MODEL_CALL_RETRIES = 2;
const CACHE_TTL_HOURS = 24; // Cache summary for 24 hours
const CACHE_COLLECTION = 'aiSummaries';

// ------------------ Integrated System Prompt ------------------
const HEALTH_REPORT_ANALYST_SYSTEM_PROMPT = `
You are an expert Health Report Analyst AI whose job is to extract, analyze, and synthesize clinical data from medical documents into a single, strict JSON object.

IMPORTANT: Under NO CIRCUMSTANCES produce diagnoses, prescribe treatment, give medical advice, or make clinical decisions. Your output MUST be purely observational and derived only from the provided document text/numbers.

CRITICAL LANGUAGE REQUIREMENT: You MUST explain all medical data in simple, everyday language that a person without medical training can understand. DO NOT transcribe or copy medical terms directly. Instead, translate and explain what they mean in plain language. Avoid technical jargon, medical terminology, and advanced language. If you use technical terms, you will receive negative scoring. Think of yourself as explaining health information to a friend or family member who has no medical background.

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
  - If the numeric value cannot be reliably parsed, set measuredValue to null and status = "PENDING".
  - IMPORTANT: In the "comments" field, explain findings in simple language. For example, instead of "Hyperglycemia detected", write "Your blood sugar level is higher than the normal range".

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
  - ALWAYS set a short comment explaining why critical was set in simple language (e.g., "Your result is 160, which is much higher than the normal upper limit of 100").

7) Confidence scoring (0.0 - 1.0)
  - Provide an overall "confidence" number between 0.0 and 1.0 representing your confidence in the correctness of the extraction and parsing.
  - Also provide "confidenceBreakdown" with numeric 0.0-1.0 scores for: legibility, valueParsing, rangeParsing, unitParsing, mappingToTestName.
  - IMPORTANT: Deduct points (negative scoring) from confidence if you use technical medical terms, jargon, or advanced language. Your explanations should be accessible to someone with no medical background.
  - Compute overall confidence conservatively as the minimum or weighted average (choose a clear approach) and include your method in "parsingNotes".

8) Document-level synthesis
  - identifiedPanels: array of recognized test groups (e.g., ["CBC", "Lipid Panel"]) — only what can be confidently inferred.
  - priorityEmoji: one of ["✅","⚠️","🚨"] based on presence of CRITICAL (🚨), non-critical HIGH/LOW (⚠️), or all NORMAL/PENDING (✅).
  - overallSummary: one short paragraph (<=3 sentences) explaining the main observations in SIMPLE, EVERYDAY LANGUAGE that anyone can understand. DO NOT use medical terms. Instead of "elevated glucose levels", say "your blood sugar is higher than normal". Instead of "hypothyroidism", say "your thyroid is working slower than it should". No advice or instructions.
  - criticalSummary: a single short phrase for the most urgent observation in plain language, or empty string if none. Example: "Your blood sugar is very high" instead of "Severe hyperglycemia detected".

9) Educational & non-medical suggestions
  - suggestedLifestyleFocus: list of broad focus areas in simple terms (e.g., ["Heart health", "Hydration", "Blood sugar control"]) based strictly on observed HIGH/LOW values. Use everyday language, not medical terms.
  - educationSearchTerms: list of keywords/phrases in plain language the user can search to learn more (non-diagnostic), e.g., ["what causes high cholesterol", "understanding thyroid test results"]. Avoid technical terms in search terms.

10) Error handling & strict output rules
  - If you cannot find any measurable results, return findings: [] and include an explanation in parsingNotes. Do not fabricate any tests.
  - All date fields must be ISO-8601 (YYYY-MM-DD) or "Not Found".
  - Provide "parsingNotes" (string) summarizing ambiguous items or redactions performed, written in simple language.
  - If you redacted or masked PHI in the input, add a boolean field "phiRedacted": true and list which elements were redacted in parsingNotes.

11) Safety and hallucination prevention
  - Do NOT invent reference ranges, units, or tests. If missing, mark as 'N/A' or null and set status to "PENDING".
  - Do NOT assume patient identity or infer clinical context beyond the document.
  - When uncertain, prefer "PENDING" and include explanatory text in parsingNotes written in plain language.

12) LANGUAGE SIMPLIFICATION RULES (CRITICAL - affects scoring)
  - NEVER transcribe medical terms directly. Always explain what they mean in simple words.
  - Replace technical terms with everyday language:
      * "Glucose" → "blood sugar"
      * "Hemoglobin A1c" → "long-term blood sugar average"
      * "LDL" → "bad cholesterol"
      * "HDL" → "good cholesterol"
      * "TSH" → "thyroid hormone level"
      * "Hypertension" → "high blood pressure"
      * "Hypotension" → "low blood pressure"
      * "Hyperglycemia" → "high blood sugar"
      * "Hypoglycemia" → "low blood sugar"
      * "Anemia" → "low red blood cells"
      * "Leukocytosis" → "high white blood cell count"
  - Use simple comparisons: "higher than normal" instead of "elevated", "lower than normal" instead of "depressed" or "reduced".
  - Explain what each test measures in simple terms in the comments field.
  - NEGATIVE SCORING: If you use medical jargon, technical terms, or advanced language without explanation, your confidence score will be reduced. Always prioritize clarity and accessibility over technical accuracy in language.

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

// System instruction specifically for suggestions generation
const SUGGESTIONS_SYSTEM_PROMPT = `
You are a helpful health assistant that generates practical, non-diagnostic suggestions for patients based on their medical reports.

CRITICAL OUTPUT REQUIREMENTS:
1. You MUST return ONLY a valid JSON array. Do NOT wrap it in markdown code blocks (no \`\`\`json or \`\`\`).
2. Do NOT add any explanatory text before or after the JSON.
3. Start your response with [ and end with ].
4. Each suggestion must be a JSON object with these exact fields:
   - type: one of "lifestyle", "diet", "follow_up", "preventive", "wellness"
   - title: a short, clear title in simple language
   - description: a detailed explanation in simple, everyday language
   - priority: one of "high", "medium", "low"

LANGUAGE REQUIREMENTS:
- Use ONLY simple, everyday language that anyone can understand
- DO NOT use medical terms or technical jargon
- Explain everything as if talking to a friend with no medical background
- Examples:
  * Instead of "Manage hyperglycemia" → "Keep your blood sugar in a healthy range"
  * Instead of "Optimize lipid profile" → "Improve your cholesterol levels"
  * Instead of "Hypertension management" → "Lower your blood pressure"

If you use technical terms or wrap the response in markdown, you will receive negative scoring.
`;

// ------------------ End of suggestions prompt ------------------

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

// --- Google Gemini API client ---
async function callModel(promptOptions, timeoutMs = API_CALL_TIMEOUT_MS) {
  if (!GEMINI_API_KEY) throw new Error('Gemini API key not configured (GEMINI_API_KEY)');
  if (!genAI) throw new Error('Gemini client not initialized');

  const systemInstruction = promptOptions.systemInstruction.parts[0].text;
  const userPrompt = promptOptions.contents[0].parts[0].text;

  // Get the model - combine system instruction with user prompt for compatibility
  const model = genAI.getGenerativeModel({ model: MODEL_NAME });

  // Combine system instruction and user prompt
  // For gemini-pro, we'll include system instruction as part of the prompt
  const fullPrompt = `${systemInstruction}\n\n${userPrompt}`;

  // Create a timeout promise
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Model call timed out')), timeoutMs);
  });

  // Make the API call with timeout
  const apiCall = async () => {
    try {
      const result = await model.generateContent(fullPrompt);
      const response = await result.response;
      return response.text();
    } catch (error) {
      throw new Error(`Gemini API Error: ${error.message}`);
    }
  };

  return withRetries(() => Promise.race([apiCall(), timeoutPromise]), { retries: MODEL_CALL_RETRIES });
}
// --- END Google Gemini API client ---


function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function safeTrim(text, n) {
  if (!text) return text || '';
  return text.length > n ? text.substring(0, n) + '...' : text;
}

// Improved JSON extraction for arrays or objects inside model output
function extractJsonFromText(text) {
  if (!text || typeof text !== 'string') return null;
  
  // Clean the text first - remove any leading/trailing whitespace
  let cleaned = text.trim();
  
  // Step 1: Try to extract from markdown code blocks (```json ... ``` or ``` ... ```)
  const fencedPatterns = [
    /```json\s*([\s\S]*?)```/i,  // ```json ... ```
    /```\s*([\s\S]*?)```/,       // ``` ... ```
  ];
  
  for (const pattern of fencedPatterns) {
    const match = cleaned.match(pattern);
    if (match && match[1]) {
      try {
        const parsed = JSON.parse(match[1].trim());
        if (parsed !== null) return parsed;
      } catch (e) {
        // Continue to next pattern
      }
    }
  }
  
  // Step 2: Try to find JSON array first (suggestions should be arrays)
  // Look for array pattern with balanced brackets
  const arrayMatch = cleaned.match(/\[\s*[\s\S]*\]/);
  if (arrayMatch) {
    let jsonStr = arrayMatch[0];
    // Try to find the complete array by counting brackets
    let bracketCount = 0;
    let inString = false;
    let escapeNext = false;
    
    for (let i = 0; i < jsonStr.length; i++) {
      const char = jsonStr[i];
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (char === '\\') {
        escapeNext = true;
        continue;
      }
      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === '[') bracketCount++;
        if (char === ']') bracketCount--;
        if (bracketCount === 0) {
          jsonStr = jsonStr.substring(0, i + 1);
          break;
        }
      }
    }
    
    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      // Continue to next method
    }
  }
  
  // Step 3: Try to find JSON object (fallback)
  const objMatch = cleaned.match(/\{\s*[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (parsed !== null) return parsed;
    } catch (e) {
      // Continue
    }
  }
  
  // Step 4: Try parsing the entire cleaned text as JSON
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed !== null) return parsed;
  } catch (e) {
    // Final fallback - return null
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

// ---------- Cache Helper Functions ----------

/**
 * Generate cache key for summary based on userId and report identifiers
 * @param {string} userId - User ID
 * @param {Array<string>|null} reportIds - Optional array of report IDs
 * @param {Date|string|null} lastReportDate - Optional last report date
 * @returns {string} Cache key
 */
function generateCacheKey(userId, reportIds = null, lastReportDate = null) {
  const parts = [userId];
  
  if (reportIds && Array.isArray(reportIds) && reportIds.length > 0) {
    // Sort report IDs for consistent hashing
    const sortedIds = [...reportIds].sort().join(',');
    parts.push(`reports:${sortedIds}`);
  }
  
  if (lastReportDate) {
    const dateStr = lastReportDate instanceof Date 
      ? lastReportDate.toISOString() 
      : String(lastReportDate);
    parts.push(`date:${dateStr}`);
  }
  
  const keyString = parts.join('|');
  return crypto.createHash('sha256').update(keyString).digest('hex');
}

/**
 * Get cached summary from Firestore
 * @param {string} cacheKey - Cache key
 * @returns {Promise<Object|null>} Cached summary or null if not found/expired
 */
async function getCachedSummary(cacheKey) {
  try {
    const cacheDoc = await db.collection(CACHE_COLLECTION).doc(cacheKey).get();
    
    if (!cacheDoc.exists) {
      return null;
    }
    
    const cacheData = cacheDoc.data();
    const now = new Date();
    const expiresAt = cacheData.expiresAt?.toDate ? cacheData.expiresAt.toDate() : new Date(cacheData.expiresAt);
    
    // Check if cache is expired
    if (expiresAt < now) {
      // Delete expired cache
      await db.collection(CACHE_COLLECTION).doc(cacheKey).delete();
      return null;
    }
    
    return {
      summary: cacheData.summary,
      generatedAt: cacheData.generatedAt,
      reportCount: cacheData.reportCount,
      lastReportDate: cacheData.lastReportDate || null
    };
  } catch (error) {
    console.error('Error getting cached summary:', error);
    return null; // Return null on error to allow fresh generation
  }
}

/**
 * Store summary in cache
 * @param {string} cacheKey - Cache key
 * @param {string} userId - User ID
 * @param {Object} summaryData - Summary data to cache
 * @returns {Promise<void>}
 */
async function setCachedSummary(cacheKey, userId, summaryData) {
  try {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CACHE_TTL_HOURS * 60 * 60 * 1000);
    
    await db.collection(CACHE_COLLECTION).doc(cacheKey).set({
      userId: userId,
      summary: summaryData.summary,
      generatedAt: summaryData.generatedAt,
      reportCount: summaryData.reportCount || 0,
      lastReportDate: summaryData.lastReportDate || null,
      expiresAt: expiresAt,
      cachedAt: now
    }, { merge: true });
  } catch (error) {
    console.error('Error caching summary:', error);
    // Don't throw - caching failure shouldn't break the request
  }
}

/**
 * Invalidate cache for a user (when new reports are added)
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
async function invalidateUserCache(userId) {
  try {
    // Delete all cache entries for this user
    const cacheSnapshot = await db.collection(CACHE_COLLECTION)
      .where('userId', '==', userId)
      .get();
    
    const batch = db.batch();
    cacheSnapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    
    if (cacheSnapshot.docs.length > 0) {
      await batch.commit();
    }
  } catch (error) {
    console.error('Error invalidating user cache:', error);
    // Don't throw - cache invalidation failure shouldn't break the request
  }
}

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
  if (!GEMINI_API_KEY) throw new Error('Gemini API key not configured');
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

    // Get userId from first report (all reports should have same userId)
    const userId = reports[0].userId;
    if (!userId) {
      throw new Error('Unable to determine user ID from reports');
    }

    // Check cache first
    const cacheKey = generateCacheKey(userId, reportIds, null);
    const cached = await getCachedSummary(cacheKey);
    if (cached) {
      console.log('Returning cached summary for reportIds:', reportIds);
      return cached;
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

      const prompt = `You are a careful, analytical medical AI assistant.\n\nFor the reports below, produce a concise bullet-list of the most important observations (3-6 bullets) and a single one-sentence patient-friendly takeaway. Do NOT provide diagnoses or medical advice; remain observational. Return plain text only.\n\nCRITICAL: Explain everything in simple, everyday language that anyone can understand. DO NOT use medical terms or technical jargon. Instead of "elevated glucose", say "blood sugar is higher than normal". Instead of "hyperlipidemia", say "cholesterol levels are high". Use words that a person without medical training would use. If you use technical terms, you will receive negative scoring.\n\n${batchText}`;

      const modelResp = await callModel({
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: HEALTH_REPORT_ANALYST_SYSTEM_PROMPT }] }
      });

      batchSummaries.push(safeTrim(modelResp || '', 2000));
    }

    // Combine batch summaries into final summary
    const combinePrompt = `You are a medical AI assistant. Combine the following batch summaries into: (1) a 3-5 sentence plain-language overview suitable for a patient, (2) a bulleted list of key findings, and (3) 3 short non-prescriptive next steps (e.g., "consider discussing X with your clinician"). Do NOT diagnose.\n\nCRITICAL LANGUAGE REQUIREMENT: Use ONLY simple, everyday language. DO NOT use medical terms, technical jargon, or advanced language. Explain everything as if talking to a friend who has no medical background. Replace all medical terms with simple explanations. For example: "blood sugar" instead of "glucose", "cholesterol" instead of "lipids", "thyroid hormone" instead of "TSH". If you use technical terms, you will receive negative scoring.\n\nBatch Summaries:\n${batchSummaries.join('\n\n---\n\n')}`;

    const finalResp = await callModel({
      contents: [{ parts: [{ text: combinePrompt }] }],
      systemInstruction: { parts: [{ text: HEALTH_REPORT_ANALYST_SYSTEM_PROMPT }] }
    });

    const summary = finalResp || 'Unable to generate summary at this time.';

    const result = { summary, generatedAt: new Date().toISOString(), reportCount };
    
    // Cache the result
    await setCachedSummary(cacheKey, userId, result);
    
    return result;
  }
  catch (err) {
    console.error('generateSummaryForReports error:', err);
    return { summary: 'Unable to generate AI summary at this time. Please try again later.', generatedAt: new Date().toISOString(), reportCount: 0 };
  }
}

async function generateSummary(userId) {
  if (!GEMINI_API_KEY) throw new Error('Gemini API key not configured');
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

    // Check cache first
    const cacheKey = generateCacheKey(userId, null, lastReportDate);
    const cached = await getCachedSummary(cacheKey);
    if (cached) {
      console.log('Returning cached summary for userId:', userId);
      return cached;
    }

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

      const prompt = `You are a careful, analytical medical AI assistant.\n\nFor the reports below, produce a concise bullet-list of the most important observations (3-6 bullets) and a single one-sentence patient-friendly takeaway. Do NOT provide diagnoses or medical advice; remain observational. Return plain text only.\n\nCRITICAL: Explain everything in simple, everyday language that anyone can understand. DO NOT use medical terms or technical jargon. Instead of "elevated glucose", say "blood sugar is higher than normal". Instead of "hyperlipidemia", say "cholesterol levels are high". Use words that a person without medical training would use. If you use technical terms, you will receive negative scoring.\n\n${batchText}`;

      const modelResp = await callModel({
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: HEALTH_REPORT_ANALYST_SYSTEM_PROMPT }] }
      });

      batchSummaries.push(safeTrim(modelResp || '', 2000));
    }

    // Combine batch summaries into final summary
    const combinePrompt = `You are a medical AI assistant. Combine the following batch summaries into: (1) a 3-5 sentence plain-language overview suitable for a patient, (2) a bulleted list of key findings, and (3) 3 short non-prescriptive next steps (e.g., "consider discussing X with your clinician"). Do NOT diagnose.\n\nCRITICAL LANGUAGE REQUIREMENT: Use ONLY simple, everyday language. DO NOT use medical terms, technical jargon, or advanced language. Explain everything as if talking to a friend who has no medical background. Replace all medical terms with simple explanations. For example: "blood sugar" instead of "glucose", "cholesterol" instead of "lipids", "thyroid hormone" instead of "TSH". If you use technical terms, you will receive negative scoring.\n\nBatch Summaries:\n${batchSummaries.join('\n\n---\n\n')}`;

    const finalResp = await callModel({
      contents: [{ parts: [{ text: combinePrompt }] }],
      systemInstruction: { parts: [{ text: HEALTH_REPORT_ANALYST_SYSTEM_PROMPT }] }
    });

    const summary = finalResp || 'Unable to generate summary at this time.';

    const result = { summary, generatedAt: new Date().toISOString(), reportCount, lastReportDate };
    
    // Cache the result
    await setCachedSummary(cacheKey, userId, result);
    
    return result;
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
  if (!GEMINI_API_KEY) throw new Error('Gemini API key not configured');
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
      ? `Based specifically on the following single medical report, produce a JSON array of practical, non-diagnostic, patient-facing suggestions. Each suggestion must contain: type (lifestyle|diet|follow_up|preventive|wellness), title, description, priority (high|medium|low). 

CRITICAL OUTPUT FORMAT: You MUST return ONLY a valid JSON array. Do NOT wrap it in markdown code blocks. Do NOT add any explanatory text before or after. Start your response with [ and end with ]. Example format:
[
  {
    "type": "lifestyle",
    "title": "Improve your cholesterol levels",
    "description": "Your cholesterol is higher than normal. Try eating more fruits and vegetables.",
    "priority": "high"
  }
]

CRITICAL LANGUAGE REQUIREMENT: Write all titles and descriptions in simple, everyday language that anyone can understand. DO NOT use medical terms or technical jargon. Use plain language explanations. For example, instead of "Manage hyperglycemia", say "Keep your blood sugar in a healthy range". Instead of "Optimize lipid profile", say "Improve your cholesterol levels". If you use technical terms, you will receive negative scoring.

${promptReports}`
      : `Based on the following medical reports, produce a JSON array of practical, non-diagnostic, patient-facing suggestions that address recurring themes or notable findings. Each suggestion must contain: type (lifestyle|diet|follow_up|preventive|wellness), title, description, priority (high|medium|low).

CRITICAL OUTPUT FORMAT: You MUST return ONLY a valid JSON array. Do NOT wrap it in markdown code blocks. Do NOT add any explanatory text before or after. Start your response with [ and end with ]. Example format:
[
  {
    "type": "lifestyle",
    "title": "Improve your cholesterol levels",
    "description": "Your cholesterol is higher than normal. Try eating more fruits and vegetables.",
    "priority": "high"
  }
]

CRITICAL LANGUAGE REQUIREMENT: Write all titles and descriptions in simple, everyday language that anyone can understand. DO NOT use medical terms or technical jargon. Use plain language explanations. For example, instead of "Manage hyperglycemia", say "Keep your blood sugar in a healthy range". Instead of "Optimize lipid profile", say "Improve your cholesterol levels". If you use technical terms, you will receive negative scoring.

${promptReports}`;

    const modelResp = await callModel({
      contents: [{ parts: [{ text: userPrompt }] }],
      systemInstruction: { parts: [{ text: SUGGESTIONS_SYSTEM_PROMPT }] }
    });

    console.log('Raw model response length:', modelResp?.length || 0);
    console.log('Raw model response preview:', modelResp?.substring(0, 200) || 'empty');

    const parsed = extractJsonFromText(modelResp);
    let suggestions = null;

    if (parsed) {
      console.log('Successfully extracted JSON, type:', Array.isArray(parsed) ? 'array' : typeof parsed);
      console.log('Parsed data length:', Array.isArray(parsed) ? parsed.length : 'not an array');
      
      // Ensure it's an array
      if (Array.isArray(parsed)) {
        // Validate using AJV if available
        if (validateSuggestions) {
          const valid = validateSuggestions(parsed);
          if (valid) {
            suggestions = parsed;
            console.log('AJV validation passed, suggestions count:', suggestions.length);
          } else {
            console.warn('AJV validation errors:', validateSuggestions.errors);
            // Try basic validation as fallback
            if (basicValidateSuggestions(parsed)) {
              suggestions = parsed;
              console.log('Basic validation passed, suggestions count:', suggestions.length);
            }
          }
        } else {
          if (basicValidateSuggestions(parsed)) {
            suggestions = parsed;
            console.log('Basic validation passed, suggestions count:', suggestions.length);
          } else {
            console.warn('Basic validation failed');
          }
        }
      } else {
        console.warn('Parsed JSON is not an array, type:', typeof parsed);
      }
    } else {
      console.warn('Failed to extract JSON from response');
      console.warn('Response preview:', modelResp?.substring(0, 500) || 'empty');
    }

    // If parsing/validation failed, fall back to conservative single suggestion
    if (!suggestions || !Array.isArray(suggestions) || suggestions.length === 0) {
      console.warn('Falling back to unstructured suggestion');
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
      console.log('Final suggestions count:', suggestions.length);
    }

    return { ...(reportId ? { reportId } : {}), suggestions, generatedAt: new Date().toISOString() };
  }
  catch (err) {
    console.error('generateSuggestions error:', err);
    return { ...(reportId ? { reportId } : {}), suggestions: [{ type: 'wellness', title: 'Failed to Generate Suggestions', description: 'An unexpected error occurred. Please try again later.', priority: 'low' }], generatedAt: new Date().toISOString() };
  }
}

module.exports = { generateSummary, generateSuggestions, generateSummaryForReports, invalidateUserCache };
