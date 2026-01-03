const axios = require('axios');
const { db } = require('../config/firebase');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
// Fallback models in order of preference
const MODELS = [
  'mistralai/devstral-2512:free',
  'openai/gpt-oss-120b:free',
  'allenai/olmo-3.1-32b-think:free',
  'xiaomi/mimo-v2-flash:free',
  'z-ai/glm-4.5-air:free',
];
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

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

// Helper function to call OpenRouter API with fallback models
async function callOpenRouter(systemPrompt, userPrompt, modelIndex = 0) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OpenRouter API key not configured. Set OPENROUTER_API_KEY.');
  }

  if (modelIndex >= MODELS.length) {
    throw new Error('All models failed. No more fallback models available.');
  }

  const model = MODELS[modelIndex];
  console.log(`Attempting API call with model: ${model} (${modelIndex + 1}/${MODELS.length})`);

  try {
    const response = await axios.post(
      OPENROUTER_API_URL,
      {
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const content = response.data.choices[0]?.message?.content || '';
    if (modelIndex > 0) {
      console.log(`Successfully used fallback model: ${model}`);
    }
    return content;
  } catch (error) {
    const errorData = error.response?.data || {};
    const errorCode = errorData.error?.code;
    const errorMessage = errorData.error?.message || error.message;
    
    console.error(`OpenRouter API Error with ${model}:`, {
      code: errorCode,
      message: errorMessage,
      model: model
    });

    // Check if we should retry with next model (429 rate limit, 503 service unavailable, or provider errors)
    const shouldRetry = errorCode === 429 || 
                        errorCode === 503 || 
                        errorMessage?.includes('rate-limited') ||
                        errorMessage?.includes('temporarily') ||
                        errorMessage?.includes('Provider returned error');

    if (shouldRetry && modelIndex < MODELS.length - 1) {
      console.log(`Retrying with next model (${modelIndex + 2}/${MODELS.length})...`);
      // Retry with next model, preserving all context
      return callOpenRouter(systemPrompt, userPrompt, modelIndex + 1);
    }

    // If last model or non-retryable error, throw
    throw new Error(`OpenRouter API Error: ${errorMessage}`);
  }
}

// Parse user text into an intent for appointments
async function inferIntentFromText(text, context = [], lastAction = null) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OpenRouter API key not configured. Set OPENROUTER_API_KEY.');
  }

  // Build conversation context string (last 6 messages)
  const contextString = Array.isArray(context)
    ? context
        .slice(-6)
        .map((m) => `${m.role || 'user'}: ${m.text}`)
        .join('\n')
    : '';
  
  const systemPrompt = `You are a precise intent classifier for a healthcare voice assistant. Your ONLY job is to extract user intent and return valid JSON.

CRITICAL OUTPUT RULES:
- Output ONLY valid JSON. No markdown, no code blocks, no explanations, no text before/after.
- Start with { and end with }. Nothing else.
- Use null for missing values, not empty strings or undefined.

AVAILABLE ACTIONS:
1. get_patient_appointments - List appointments (supports filters: status, date, startDate, endDate)
2. cancel_appointment - Cancel by appointmentId
3. book_appointment - Book new appointment (requires: doctorName/doctorId, date, time)
4. navigate - Navigate to page (route required: /patient/reports, /patient/appointments, /patient/ai-summary, /patient/suggestions, /patient/profile, /patient/submit-report)
5. get_reports - List medical reports (supports: category, fileType, startDate, endDate, search)
6. get_ai_summary - Get health summary
7. get_ai_suggestions - Get health suggestions

REQUIRED JSON STRUCTURE:
{
  "action": "action_name",
  "filters": {"status": null, "date": null, "startDate": null, "endDate": null},
  "appointmentId": null,
  "booking": {"doctorName": null, "doctorId": null, "date": null, "time": null, "duration": 30, "notes": null},
  "navigation": {"route": null, "moduleId": null},
  "reportFilters": {"category": null, "fileType": null, "startDate": null, "endDate": null, "search": null},
  "needsClarification": false,
  "followUp": null
}

EXTRACTION RULES:
- Dates: Convert "today"/"tomorrow"/weekdays to ISO YYYY-MM-DD. "upcoming"/"next" → startDate=today, endDate=null.
- Time: Convert to 24h HH:mm format ("2 PM" → "14:00", "10:30 AM" → "10:30").
- Doctor names: Extract from "Dr. Smith", "Smith", "doctor smith" → doctorName="Smith".
- Routes: Map keywords → "/patient/reports", "/patient/appointments", "/patient/ai-summary", "/patient/suggestions", "/patient/profile", "/patient/submit-report".
- Status: Map "pending"/"confirmed"/"completed"/"cancelled" exactly.

CLARIFICATION RULES:
- If booking missing doctorName → needsClarification=true, followUp="Which doctor would you like to book with?"
- If booking missing date → needsClarification=true, followUp="What date would you like to book?"
- If booking missing time → needsClarification=true, followUp="What time would you like to book?"
- If cancel missing appointmentId → needsClarification=true, followUp="Which appointment would you like to cancel?"
- Never invent IDs, dates, or data. Use null if uncertain.

OUTPUT: Return ONLY the JSON object. No other text.`;

  const userPrompt = `CONTEXT:
${contextString || 'No prior messages'}

LAST ACTION: ${lastAction || 'None'}

CURRENT USER INPUT: "${text}"

TASK: Analyze the user's intent and extract all relevant information. Return ONLY the JSON object matching the required structure.`;

  try {
    const content = await callOpenRouter(systemPrompt, userPrompt);
    
    console.log('OpenRouter raw response:', content.substring(0, 500)); // Log first 500 chars for debugging
    
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
      navigation: parsed.navigation || {
        route: null,
        moduleId: null,
      },
      reportFilters: parsed.reportFilters || {},
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
      navigation: null,
      reportFilters: {},
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
      navigation: null,
      reportFilters: {},
      needsClarification: true,
      followUp: 'Which appointment would you like to cancel? Please provide the appointment ID.',
    };
  }
  
  // Check for navigation intents
  const navRoute = getNavigationRoute(text);
  if (navRoute) {
    return {
      action: 'navigate',
      filters: {},
      appointmentId: null,
      booking: null,
      navigation: { route: navRoute, moduleId: null },
      reportFilters: {},
      needsClarification: false,
      followUp: null,
    };
  }
  
  // Check for reports
  if (lowerText.includes('report') && (lowerText.includes('show') || lowerText.includes('list') || lowerText.includes('view') || lowerText.includes('my'))) {
    return {
      action: 'get_reports',
      filters: {},
      appointmentId: null,
      booking: null,
      navigation: null,
      reportFilters: {},
      needsClarification: false,
      followUp: null,
    };
  }
  
  // Check for AI summary
  if (lowerText.includes('summary') || lowerText.includes('ai summary') || lowerText.includes('health summary')) {
    return {
      action: 'get_ai_summary',
      filters: {},
      appointmentId: null,
      booking: null,
      navigation: null,
      reportFilters: {},
      needsClarification: false,
      followUp: null,
    };
  }
  
  // Check for suggestions
  if (lowerText.includes('suggestion') || lowerText.includes('recommendation') || lowerText.includes('advice')) {
    return {
      action: 'get_ai_suggestions',
      filters: {},
      appointmentId: null,
      booking: null,
      navigation: null,
      reportFilters: {},
      needsClarification: false,
      followUp: null,
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
    navigation: null,
    reportFilters: {},
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

// Fetch patient reports
async function fetchPatientReports(userId, filters = {}) {
  let query = db.collection('reports').where('userId', '==', userId);

  if (filters.category) {
    query = query.where('category', '==', filters.category);
  }
  if (filters.fileType) {
    query = query.where('fileType', '==', filters.fileType);
  }
  if (filters.startDate) {
    query = query.where('uploadDate', '>=', filters.startDate);
  }
  if (filters.endDate) {
    query = query.where('uploadDate', '<=', filters.endDate);
  }

  query = query.orderBy('uploadDate', 'desc');

  const snapshot = await query.get();
  let reports = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      reportId: doc.id,
      fileName: data.fileName,
      category: data.category,
      fileType: data.fileType,
      uploadDate: data.uploadDate,
    };
  });

  // Apply search filter if provided
  if (filters.search) {
    const searchLower = filters.search.toLowerCase();
    reports = reports.filter(report => 
      report.fileName?.toLowerCase().includes(searchLower) ||
      report.category?.toLowerCase().includes(searchLower)
    );
  }

  return reports;
}

function summarizeReports(reports) {
  if (!reports.length) {
    return 'You have no reports.';
  }

  const lines = reports.slice(0, 5).map((r) => {
    return `${r.fileName} (${r.category || 'uncategorized'})`;
  });

  const more = reports.length > 5 ? ` ...and ${reports.length - 5} more.` : '';
  return `You have ${reports.length} report${reports.length === 1 ? '' : 's'}: ${lines.join('; ')}${more}`;
}

// Map navigation keywords to routes
function getNavigationRoute(text) {
  const lowerText = text.toLowerCase();
  
  const routeMap = {
    'reports': '/patient/reports',
    'report': '/patient/reports',
    'appointments': '/patient/appointments',
    'appointment': '/patient/appointments',
    'ai summary': '/patient/ai-summary',
    'summary': '/patient/ai-summary',
    'suggestions': '/patient/suggestions',
    'suggestion': '/patient/suggestions',
    'profile': '/patient/profile',
    'submit report': '/patient/submit-report',
    'upload report': '/patient/submit-report',
    'book appointment': '/patient/book-appointment',
    'share reports': '/patient/share-reports',
    'export reports': '/patient/export-reports',
  };

  for (const [keyword, route] of Object.entries(routeMap)) {
    if (lowerText.includes(keyword)) {
      return route;
    }
  }

  return null;
}

// Generate humanized, context-aware response using LLM
async function generateHumanizedResponse(userQuery, data, action, context = []) {
  try {
    if (!OPENROUTER_API_KEY) {
      console.warn('OpenRouter API not configured, using fallback summary');
      return fallbackSummary(data, action);
    }
    
    // Build context string from conversation history
    const contextString = context.length > 0
      ? context.map((msg, idx) => {
          const role = msg.role === 'user' ? 'User' : 'Assistant';
          return `${role}: ${msg.text}`;
        }).join('\n')
      : '(no prior conversation)';
    
    // Build data summary for the LLM
    let dataSummary = '';
    if (action === 'get_patient_appointments') {
      if (data.length === 0) {
        dataSummary = 'The user has no appointments matching their query.';
      } else {
        dataSummary = `The user has ${data.length} appointment(s):\n${data.map((apt, idx) => {
          const date = apt.date ? new Date(apt.date).toLocaleDateString() : 'Date TBD';
          const time = apt.time || 'Time TBD';
          const doctor = apt.doctorName || 'Doctor TBD';
          const status = apt.status || 'pending';
          return `${idx + 1}. ${doctor} on ${date} at ${time} (${status})`;
        }).join('\n')}`;
      }
    } else if (action === 'get_reports') {
      if (data.length === 0) {
        dataSummary = 'The user has no medical reports.';
      } else {
        dataSummary = `The user has ${data.length} report(s):\n${data.map((rpt, idx) => {
          return `${idx + 1}. ${rpt.fileName} (${rpt.category || 'uncategorized'}) - uploaded ${rpt.uploadDate || 'recently'}`;
        }).join('\n')}`;
      }
    } else if (action === 'book_appointment') {
      dataSummary = `Appointment booking ${data.success ? 'successful' : 'failed'}. ${data.message || ''}`;
    } else if (action === 'cancel_appointment') {
      dataSummary = `Appointment cancellation ${data.success ? 'successful' : 'failed'}. ${data.message || ''}`;
    } else if (action === 'get_ai_summary') {
      dataSummary = typeof data === 'string' ? data : JSON.stringify(data);
    } else if (action === 'get_ai_suggestions') {
      const suggestionsList = Array.isArray(data) ? data : (data.suggestions || []);
      dataSummary = suggestionsList.length > 0
        ? `Suggestions: ${suggestionsList.map((s, idx) => `${idx + 1}. ${s.title || s.type || 'Suggestion'}: ${s.description || ''}`).join('\n')}`
        : 'No suggestions available.';
    } else {
      dataSummary = typeof data === 'string' ? data : JSON.stringify(data);
    }
    
    const systemPrompt = `You are a warm, empathetic healthcare voice assistant. Your responses are:
- Natural and conversational (not robotic)
- Concise (1-3 sentences maximum)
- Warm and empathetic (healthcare context)
- Directly addressing the user's query
- Incorporating data naturally (not just listing)

CRITICAL: Return ONLY the response text. No quotes, no explanations, no markdown, no prefixes.`;

    const prompt = `CONVERSATION HISTORY:
${contextString}

USER QUERY: "${userQuery}"

ACTION EXECUTED: ${action}

DATA RESULT:
${dataSummary}

TASK: Generate a natural, warm response that directly answers the user's query using the data above. Be conversational, empathetic, and concise.`;
    const response = await callOpenRouter(systemPrompt, prompt);
    
    return response.trim().replace(/^["']|["']$/g, ''); // Remove surrounding quotes if any
  } catch (error) {
    console.error('Error generating humanized response:', error);
    // Fallback to simple summary
    return fallbackSummary(data, action);
  }
}

// Fallback summary if LLM fails
function fallbackSummary(data, action) {
  if (action === 'get_patient_appointments') {
    if (data.length === 0) return "You don't have any appointments scheduled.";
    return `You have ${data.length} appointment${data.length === 1 ? '' : 's'} coming up.`;
  } else if (action === 'get_reports') {
    if (data.length === 0) return "You don't have any reports uploaded yet.";
    return `You have ${data.length} report${data.length === 1 ? '' : 's'} in your records.`;
  } else if (action === 'book_appointment') {
    return data.success ? "Great! I've booked your appointment." : "Sorry, I couldn't book your appointment.";
  } else if (action === 'cancel_appointment') {
    return data.success ? "I've cancelled your appointment." : "Sorry, I couldn't cancel your appointment.";
  }
  return 'I found that information for you.';
}

module.exports = {
  inferIntentFromText,
  fetchPatientAppointments,
  summarizeAppointments,
  cancelAppointment,
  searchDoctors,
  getAvailableSlots,
  bookAppointment,
  fetchPatientReports,
  summarizeReports,
  getNavigationRoute,
  generateHumanizedResponse,
};


