const { GoogleGenerativeAI } = require('@google/generative-ai');
const { db } = require('../config/firebase');

// Initialize Gemini AI
const genAI = process.env.GEMINI_API_KEY 
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

const MODEL_NAME = 'gemini-pro';

/**
 * Generate AI summary from user's reports
 * @param {string} userId - User ID
 * @returns {Promise<{summary: string, generatedAt: string, reportCount: number, lastReportDate: string}>}
 */
async function generateSummary(userId) {
  try {
    if (!genAI) {
      throw new Error('Gemini API key not configured');
    }

    // Fetch all user reports
    const reportsSnapshot = await db.collection('reports')
      .where('userId', '==', userId)
      .orderBy('reportDate', 'desc')
      .get();

    if (reportsSnapshot.empty) {
      return {
        summary: 'No medical reports found. Upload reports to get personalized health insights.',
        generatedAt: new Date().toISOString(),
        reportCount: 0,
        lastReportDate: null
      };
    }

    const reports = reportsSnapshot.docs.map(doc => doc.data());
    const reportCount = reports.length;
    const lastReportDate = reports[0].reportDate || null;

    // Prepare report data for AI
    const reportSummaries = reports.map((report, index) => {
      const extractedText = report.extractedText || 'No text extracted';
      const textPreview = extractedText.substring(0, 500); // First 500 chars
      
      return `
Report ${index + 1}:
- Title: ${report.title}
- Date: ${report.reportDate}
- Category: ${report.category}
- Doctor: ${report.doctorName || 'N/A'}
- Clinic: ${report.clinicName || 'N/A'}
- Content Preview: ${textPreview}
`;
    }).join('\n---\n');

    // Create prompt for Gemini
    const prompt = `As a medical AI assistant, analyze the following medical reports and provide a comprehensive health summary. Focus on:
1. Overall health trends and patterns
2. Key findings across reports
3. Notable health indicators
4. Areas of concern (if any)
5. General health status assessment

Medical Reports:
${reportSummaries}

Please provide a clear, informative, and easy-to-understand health summary based on these reports. Keep it professional and focused on insights that would be useful for the patient.`;

    const model = genAI.getGenerativeModel({ model: MODEL_NAME });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const summary = response.text();

    return {
      summary: summary || 'Unable to generate summary at this time.',
      generatedAt: new Date().toISOString(),
      reportCount,
      lastReportDate
    };
  } catch (error) {
    console.error('Error generating AI summary:', error);
    
    // Fallback response
    return {
      summary: 'Unable to generate AI summary at this time. Please try again later.',
      generatedAt: new Date().toISOString(),
      reportCount: 0,
      lastReportDate: null
    };
  }
}

/**
 * Generate AI suggestions from user's reports
 * @param {string} userId - User ID
 * @param {string} reportId - Optional specific report ID
 * @returns {Promise<{suggestions: Array, generatedAt: string, reportId?: string}>}
 */
async function generateSuggestions(userId, reportId = null) {
  try {
    if (!genAI) {
      throw new Error('Gemini API key not configured');
    }

    let reports = [];
    let targetReportId = reportId;

    if (reportId) {
      // Get specific report
      const reportDoc = await db.collection('reports').doc(reportId).get();
      if (reportDoc.exists) {
        const reportData = reportDoc.data();
        if (reportData.userId === userId) {
          reports = [reportData];
          targetReportId = reportId;
        }
      }
    } else {
      // Get all user reports
      const reportsSnapshot = await db.collection('reports')
        .where('userId', '==', userId)
        .orderBy('reportDate', 'desc')
        .limit(10) // Limit to most recent 10 reports
        .get();
      
      reports = reportsSnapshot.docs.map(doc => doc.data());
    }

    if (reports.length === 0) {
      return {
        suggestions: [],
        generatedAt: new Date().toISOString(),
        ...(targetReportId ? { reportId: targetReportId } : {})
      };
    }

    // Prepare report data for AI
    const reportData = reports.map((report, index) => {
      const extractedText = report.extractedText || 'No text extracted';
      const textPreview = extractedText.substring(0, 1000); // First 1000 chars
      
      return `
Report ${index + 1}:
- Title: ${report.title}
- Date: ${report.reportDate}
- Category: ${report.category}
- Doctor: ${report.doctorName || 'N/A'}
- Clinic: ${report.clinicName || 'N/A'}
- Content: ${textPreview}
`;
    }).join('\n---\n');

    // Create prompt for Gemini
    const prompt = reportId 
      ? `As a medical AI assistant, analyze the following medical report and provide personalized health suggestions. Focus on:
1. Lifestyle recommendations based on findings
2. Diet suggestions if relevant
3. Follow-up actions that may be needed
4. Preventive measures
5. General wellness tips related to the report findings

Return suggestions in the following JSON format (array of objects):
[
  {
    "type": "lifestyle|diet|follow_up|preventive|wellness",
    "title": "Short title",
    "description": "Detailed description",
    "priority": "high|medium|low"
  }
]

Medical Report:
${reportData}

Provide practical, actionable suggestions. Return only valid JSON array.`
      : `As a medical AI assistant, analyze the following medical reports and provide personalized health suggestions based on overall patterns and findings. Focus on:
1. Lifestyle recommendations
2. Diet and nutrition suggestions
3. Follow-up actions
4. Preventive measures
5. General wellness tips

Return suggestions in the following JSON format (array of objects):
[
  {
    "type": "lifestyle|diet|follow_up|preventive|wellness",
    "title": "Short title",
    "description": "Detailed description",
    "priority": "high|medium|low"
  }
]

Medical Reports:
${reportData}

Provide practical, actionable suggestions based on all reports. Return only valid JSON array.`;

    const model = genAI.getGenerativeModel({ model: MODEL_NAME });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const responseText = response.text();

    // Parse JSON from response (may be wrapped in markdown code blocks)
    let suggestions = [];
    try {
      // Try to extract JSON from markdown code blocks if present
      const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, responseText];
      const jsonText = jsonMatch[1] || responseText;
      suggestions = JSON.parse(jsonText);
      
      // Validate suggestions structure
      if (!Array.isArray(suggestions)) {
        suggestions = [];
      }
      
      // Ensure each suggestion has required fields
      suggestions = suggestions
        .filter(s => s.title && s.description)
        .map(s => ({
          type: s.type || 'wellness',
          title: s.title,
          description: s.description,
          priority: s.priority || 'medium'
        }));
    } catch (parseError) {
      console.error('Error parsing AI suggestions JSON:', parseError);
      // Fallback: create a single suggestion from the text
      suggestions = [{
        type: 'wellness',
        title: 'Health Recommendation',
        description: responseText.substring(0, 500),
        priority: 'medium'
      }];
    }

    return {
      ...(targetReportId ? { reportId: targetReportId } : {}),
      suggestions,
      generatedAt: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error generating AI suggestions:', error);
    
    // Fallback response
    return {
      ...(reportId ? { reportId } : {}),
      suggestions: [{
        type: 'wellness',
        title: 'Unable to Generate Suggestions',
        description: 'Unable to generate AI suggestions at this time. Please try again later.',
        priority: 'low'
      }],
      generatedAt: new Date().toISOString()
    };
  }
}

module.exports = {
  generateSummary,
  generateSuggestions
};

