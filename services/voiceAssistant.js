const { GoogleGenerativeAI } = require('@google/generative-ai');
const { db } = require('../config/firebase');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL_NAME = 'gemini-2.5-flash';

// Minimal singleton client
let genAI = null;
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
}

// Extract JSON object from text (handles markdown code blocks, extra text, etc.)
function extractJsonFromText(text) {
  if (!text || typeof text !== 'string') return null;
  
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
        if (parsed !== null && typeof parsed === 'object') return parsed;
      } catch (e) {
        // Continue to next pattern
      }
    }
  }
  
  // Step 2: Try to find JSON object with balanced braces
  const objMatch = cleaned.match(/\{\s*[\s\S]*\}/);
  if (objMatch) {
    let jsonStr = objMatch[0];
    // Try to find the complete object by counting braces
    let braceCount = 0;
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
        if (char === '{') braceCount++;
        if (char === '}') braceCount--;
        if (braceCount === 0) {
          jsonStr = jsonStr.substring(0, i + 1);
          break;
        }
      }
    }
    
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch (e) {
      // Continue to next method
    }
  }
  
  // Step 3: Try parsing the entire cleaned text as JSON
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed !== null && typeof parsed === 'object') return parsed;
  } catch (e) {
    // Final fallback
  }
  
  return null;
}

// Parse user text into an intent for appointments
async function inferIntentFromText(text) {
  if (!genAI) {
    throw new Error('Gemini client not initialized. Set GEMINI_API_KEY.');
  }

  const model = genAI.getGenerativeModel({ 
    model: MODEL_NAME,
    generationConfig: {
      responseMimeType: 'application/json',
    }
  });
  
  const system = `You are an intent classifier for a healthcare appointments assistant.
You MUST output ONLY valid JSON, no markdown, no code blocks, no explanations, no prose, no text before or after.

Supported actions:
  - get_patient_appointments: list a patient's appointments with optional filters.
  - cancel_appointment: cancel an appointment by id.

If information is missing, set needsClarification=true and ask only ONE concise question in followUp.

You MUST return this exact JSON structure:
{
  "action": "get_patient_appointments" | "cancel_appointment",
  "filters": {
    "status": "pending" | "confirmed" | "completed" | "cancelled" | null,
    "date": "YYYY-MM-DD" | null,
    "startDate": "YYYY-MM-DD" | null,
    "endDate": "YYYY-MM-DD" | null
  },
  "appointmentId": "string" | null,
  "needsClarification": false,
  "followUp": "string" | null
}

Rules:
- Do not invent IDs or dates.
- If cancel is requested without an appointment id, set needsClarification=true and followUp asking for the appointment id.
- Prefer specific date if user said today/tomorrow/weekday; resolve to ISO date (YYYY-MM-DD).
- If user asks for upcoming/next, set startDate=today (YYYY-MM-DD) and leave endDate=null.
- Output ONLY the JSON object, nothing else. No markdown, no code blocks, no explanations.`;

  const prompt = `${system}\n\nUser: ${text}\nAssistant:`;

  try {
    const result = await model.generateContent(prompt);
    const content = await result.response.text();
    
    console.log('Gemini raw response:', content.substring(0, 500)); // Log first 500 chars for debugging
    
    // Try direct parse first
    let parsed;
    try {
      parsed = JSON.parse(content.trim());
    } catch (e) {
      console.log('Direct JSON parse failed, trying extraction...');
      // If direct parse fails, try extraction
      parsed = extractJsonFromText(content);
      if (!parsed) {
        console.error('Failed to parse JSON. Full response:', content);
        // Fallback: try to infer intent from keywords
        return fallbackIntentInference(text);
      }
    }
    
    // Validate structure
    if (!parsed || typeof parsed !== 'object') {
      console.error('Parsed result is not a valid object:', parsed);
      return fallbackIntentInference(text);
    }
    
    // Ensure required fields exist with defaults
    return {
      action: parsed.action || 'get_patient_appointments',
      filters: parsed.filters || {},
      appointmentId: parsed.appointmentId || null,
      needsClarification: parsed.needsClarification || false,
      followUp: parsed.followUp || null,
    };
  } catch (e) {
    console.error('Error in inferIntentFromText:', e.message, e.stack);
    // Fallback to keyword-based inference
    return fallbackIntentInference(text);
  }
}

// Fallback intent inference using keyword matching
function fallbackIntentInference(text) {
  const lowerText = text.toLowerCase();
  const today = new Date().toISOString().split('T')[0];
  
  // Check for cancel intent
  if (lowerText.includes('cancel') || lowerText.includes('delete') || lowerText.includes('remove')) {
    return {
      action: 'cancel_appointment',
      filters: {},
      appointmentId: null,
      needsClarification: true,
      followUp: 'Which appointment would you like to cancel? Please provide the appointment ID.',
    };
  }
  
  // Check for date filters
  const filters = {};
  if (lowerText.includes('today')) {
    filters.date = today;
  } else if (lowerText.includes('tomorrow')) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    filters.date = tomorrow.toISOString().split('T')[0];
  } else if (lowerText.includes('upcoming') || lowerText.includes('next') || lowerText.includes('future')) {
    filters.startDate = today;
  }
  
  // Check for status filters
  if (lowerText.includes('pending')) filters.status = 'pending';
  else if (lowerText.includes('confirmed')) filters.status = 'confirmed';
  else if (lowerText.includes('completed')) filters.status = 'completed';
  else if (lowerText.includes('cancelled') || lowerText.includes('canceled')) filters.status = 'cancelled';
  
  return {
    action: 'get_patient_appointments',
    filters,
    appointmentId: null,
    needsClarification: false,
    followUp: null,
  };
}

async function fetchPatientAppointments(userId, filters = {}) {
  let query = db.collection('appointments').where('patientId', '==', userId);

  if (filters.status) {
    query = query.where('status', '==', filters.status);
  }
  if (filters.date) {
    query = query.where('date', '==', filters.date);
  } else {
    if (filters.startDate) {
      query = query.where('date', '>=', filters.startDate);
    }
    if (filters.endDate) {
      query = query.where('date', '<=', filters.endDate);
    }
  }

  query = query.orderBy('date', 'desc').orderBy('time', 'desc');

  const snapshot = await query.get();
  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      appointmentId: doc.id,
      doctorName: data.doctorName,
      doctorSpecialization: data.doctorSpecialization,
      date: data.date,
      time: data.time,
      status: data.status,
      notes: data.notes || null,
    };
  });
}

function summarizeAppointments(appointments) {
  if (!appointments.length) {
    return 'You have no appointments for that range.';
  }

  const lines = appointments.slice(0, 5).map((a) => {
    return `${a.date} at ${a.time} with ${a.doctorName || 'your doctor'} (${a.status})`;
  });

  const more = appointments.length > 5 ? ` ...and ${appointments.length - 5} more.` : '';
  return lines.join('; ') + more;
}

async function cancelAppointment(appointmentId, userId) {
  const ref = db.collection('appointments').doc(appointmentId);
  const snap = await ref.get();
  if (!snap.exists) {
    return { success: false, message: 'Appointment not found' };
  }
  const data = snap.data();
  if (data.patientId !== userId && data.doctorId !== userId) {
    return { success: false, message: 'You do not have access to this appointment' };
  }

  await ref.update({
    status: 'cancelled',
    updatedAt: new Date().toISOString(),
  });

  return { success: true, message: 'Appointment cancelled' };
}

module.exports = {
  inferIntentFromText,
  fetchPatientAppointments,
  summarizeAppointments,
  cancelAppointment,
};


