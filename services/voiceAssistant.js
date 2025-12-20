const { GoogleGenerativeAI } = require('@google/generative-ai');
const { db } = require('../config/firebase');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL_NAME = 'gemini-2.5-flash';

// Minimal singleton client
let genAI = null;
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
}

// Parse user text into an intent for appointments
async function inferIntentFromText(text) {
  if (!genAI) {
    throw new Error('Gemini client not initialized. Set GEMINI_API_KEY.');
  }

  const model = genAI.getGenerativeModel({ model: MODEL_NAME });
  const system = `
You are an intent classifier for a healthcare appointments assistant.
Only output compact JSON, no prose.
Supported actions:
  - get_patient_appointments: list a patient's appointments with optional filters.
  - cancel_appointment: cancel an appointment by id.
If information is missing, set needsClarification=true and ask only ONE concise question in followUp.

Return JSON with this shape:
{
  "action": "get_patient_appointments" | "cancel_appointment",
  "filters": {
    "status": "pending|confirmed|completed|cancelled|null",
    "date": "YYYY-MM-DD or null",
    "startDate": "YYYY-MM-DD or null",
    "endDate": "YYYY-MM-DD or null"
  },
  "appointmentId": "string or null",
  "needsClarification": false,
  "followUp": "short question if clarification needed"
}
Rules:
- Do not invent IDs or dates.
- If cancel is requested without an appointment id, set needsClarification=true and followUp asking for the appointment id.
- Prefer specific date if user said today/tomorrow/weekday; resolve to ISO date.
- If user asks for upcoming/next, set startDate=today and leave endDate=null.
`;

  const prompt = `${system}\n\nUser: ${text}\nAssistant:`;

  const result = await model.generateContent(prompt);
  const content = await result.response.text();

  try {
    const parsed = JSON.parse(content);
    return parsed;
  } catch (e) {
    throw new Error('Failed to parse intent JSON from model');
  }
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


