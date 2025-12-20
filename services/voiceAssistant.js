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
async function inferIntentFromText(text, context = [], lastAction = null) {
  if (!genAI) {
    throw new Error('Gemini client not initialized. Set GEMINI_API_KEY.');
  }

  // Build conversation context string (last 6 messages)
  const contextString = Array.isArray(context)
    ? context
        .slice(-6)
        .map((m) => `${m.role || 'user'}: ${m.text}`)
        .join('\n')
    : '';

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
  - book_appointment: book a new appointment with a doctor.

If information is missing, set needsClarification=true and ask only ONE concise question in followUp.
Keep responses concise and natural; it's okay to be informal and brief.

You MUST return this exact JSON structure:
{
  "action": "get_patient_appointments" | "cancel_appointment" | "book_appointment",
  "filters": {
    "status": "pending" | "confirmed" | "completed" | "cancelled" | null,
    "date": "YYYY-MM-DD" | null,
    "startDate": "YYYY-MM-DD" | null,
    "endDate": "YYYY-MM-DD" | null
  },
  "appointmentId": "string" | null,
  "booking": {
    "doctorName": "string" | null,
    "doctorId": "string" | null,
    "date": "YYYY-MM-DD" | null,
    "time": "HH:mm" | null,
    "duration": 30,
    "notes": "string" | null
  },
  "needsClarification": false,
  "followUp": "string" | null
}

Rules:
- Do not invent IDs or dates.
- If cancel is requested without an appointment id, set needsClarification=true and followUp asking for the appointment id.
- If book_appointment is requested:
  - Extract doctorName from user input (e.g., "Dr. Smith", "Smith", "doctor smith")
  - Extract date (resolve today/tomorrow/weekday to ISO date YYYY-MM-DD)
  - Extract time in HH:mm format (e.g., "2 PM" → "14:00", "10:30 AM" → "10:30")
  - If doctorName is missing, set needsClarification=true and followUp="Which doctor would you like to book with?"
  - If date is missing, set needsClarification=true and followUp="What date would you like to book?"
  - If time is missing, set needsClarification=true and followUp="What time would you like to book?"
- Prefer specific date if user said today/tomorrow/weekday; resolve to ISO date (YYYY-MM-DD).
- If user asks for upcoming/next, set startDate=today (YYYY-MM-DD) and leave endDate=null.
- Output ONLY the JSON object, nothing else. No markdown, no code blocks, no explanations.`;

  const prompt = `${system}

Previous context:
${contextString || '(no prior messages)'}

Previous action (if any): ${lastAction || 'unknown'}

User: ${text}
Assistant:`;

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
      booking: parsed.booking || {
        doctorName: null,
        doctorId: null,
        date: null,
        time: null,
        duration: 30,
        notes: null,
      },
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
  
  // Check for book intent
  if (lowerText.includes('book') || lowerText.includes('schedule') || lowerText.includes('make appointment') || lowerText.includes('appointment with')) {
    const booking = {
      doctorName: null,
      doctorId: null,
      date: null,
      time: null,
      duration: 30,
      notes: null,
    };
    
    // Try to extract doctor name (simple pattern matching)
    const doctorMatch = lowerText.match(/(?:dr\.?|doctor)\s+([a-z]+)|with\s+([a-z]+)/i);
    if (doctorMatch) {
      booking.doctorName = doctorMatch[1] || doctorMatch[2];
    }
    
    // Try to extract date
    if (lowerText.includes('today')) {
      booking.date = today;
    } else if (lowerText.includes('tomorrow')) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      booking.date = tomorrow.toISOString().split('T')[0];
    }
    
    // Try to extract time (simple patterns)
    const timeMatch = lowerText.match(/(\d{1,2})\s*(?:am|pm|:(\d{2})\s*(?:am|pm)?)/i);
    if (timeMatch) {
      let hour = parseInt(timeMatch[1]);
      const minute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
      const isPM = lowerText.includes('pm') || (hour < 12 && lowerText.includes('p'));
      if (isPM && hour !== 12) hour += 12;
      if (!isPM && hour === 12) hour = 0;
      booking.time = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
    }
    
    // Determine what's missing
    const missing = [];
    if (!booking.doctorName) missing.push('doctor');
    if (!booking.date) missing.push('date');
    if (!booking.time) missing.push('time');
    
    return {
      action: 'book_appointment',
      filters: {},
      appointmentId: null,
      booking,
      needsClarification: missing.length > 0,
      followUp: missing.length > 0 
        ? `To book an appointment, I need: ${missing.join(', ')}. ${missing.length === 1 ? 'What' : 'What are'} the ${missing.join(' and ')}?`
        : null,
    };
  }
  
  // Check for cancel intent
  if (lowerText.includes('cancel') || lowerText.includes('delete') || lowerText.includes('remove')) {
    return {
      action: 'cancel_appointment',
      filters: {},
      appointmentId: null,
      booking: null,
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
    booking: null,
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

// Search for doctors by name
async function searchDoctors(doctorName) {
  if (!doctorName) return [];
  
  const snapshot = await db.collection('doctors').get();
  const searchLower = doctorName.toLowerCase();
  
  const doctors = snapshot.docs
    .map(doc => {
      const data = doc.data();
      return {
        doctorId: doc.id,
        name: data.name,
        specialization: data.specialization,
        rating: data.rating || 0,
      };
    })
    .filter(doctor => {
      const nameLower = doctor.name.toLowerCase();
      return nameLower.includes(searchLower) || 
             nameLower.includes(searchLower.replace('dr.', '').replace('doctor', '').trim());
    });
  
  return doctors;
}

// Get available time slots for a doctor on a specific date
async function getAvailableSlots(doctorId, date) {
  // Get all appointments for this doctor on this date
  const appointmentsSnapshot = await db.collection('appointments')
    .where('doctorId', '==', doctorId)
    .where('date', '==', date)
    .where('status', 'in', ['pending', 'confirmed'])
    .get();
  
  const bookedSlots = appointmentsSnapshot.docs.map(doc => doc.data().time);
  
  // Generate available slots (9 AM to 5 PM, 30-minute intervals)
  const availableSlots = [];
  for (let hour = 9; hour < 17; hour++) {
    for (let minute = 0; minute < 60; minute += 30) {
      const time = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
      if (!bookedSlots.includes(time)) {
        availableSlots.push(time);
      }
    }
  }
  
  return availableSlots;
}

// Book an appointment
async function bookAppointment(userId, booking) {
  const { doctorId, date, time, duration = 30, notes } = booking;
  
  if (!doctorId || !date || !time) {
    return { success: false, message: 'Missing required booking information' };
  }
  
  // Verify doctor exists
  const doctorDoc = await db.collection('doctors').doc(doctorId).get();
  if (!doctorDoc.exists) {
    return { success: false, message: 'Doctor not found' };
  }
  
  const doctorData = doctorDoc.data();
  
  // Check if slot is available
  const existingAppointments = await db.collection('appointments')
    .where('doctorId', '==', doctorId)
    .where('date', '==', date)
    .where('time', '==', time)
    .where('status', 'in', ['pending', 'confirmed'])
    .get();
  
  if (!existingAppointments.empty) {
    return { success: false, message: 'This time slot is already booked. Please choose another time.' };
  }
  
  // Get patient info
  const patientDoc = await db.collection('users').doc(userId).get();
  const patientData = patientDoc.data();
  
  // Create appointment
  const appointmentRef = db.collection('appointments').doc();
  const appointmentId = appointmentRef.id;
  
  const appointmentData = {
    appointmentId,
    doctorId,
    doctorName: doctorData.name,
    doctorSpecialization: doctorData.specialization,
    patientId: userId,
    patientName: patientData.name,
    date,
    time,
    duration,
    status: 'pending',
    notes: notes || null,
    doctorNotes: null,
    createdAt: new Date().toISOString(),
  };
  
  await appointmentRef.set(appointmentData);
  
  return {
    success: true,
    message: `Appointment booked successfully with ${doctorData.name} on ${date} at ${time}`,
    appointmentId,
  };
}

module.exports = {
  inferIntentFromText,
  fetchPatientAppointments,
  summarizeAppointments,
  cancelAppointment,
  searchDoctors,
  getAvailableSlots,
  bookAppointment,
};


