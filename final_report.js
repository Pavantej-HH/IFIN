const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT;
const MONGODB_URI = process.env.MONGODB_URI;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const API_URL = 'https://api.mistral.ai/v1/chat/completions';
const DB_NAME = 'Marketplace-ifin';

let db;

async function connectToDatabase() {
  try {
    console.log('Connecting to MongoDB...');
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DB_NAME);
    console.log('Connected to MongoDB successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    process.exit(1);
  }
}

async function getContestLifeCycleData(contestId) {
  const objectIdContestId = new ObjectId(contestId);
  const contestLifeCycleDocs = await db.collection('contestLifeCycle')
    .find({ contestId: objectIdContestId })
    .sort({ createdDate: 1 })
    .toArray();
  return contestLifeCycleDocs;
}

async function getRecruiterStatsData(contestId) {
  const objectIdContestId = new ObjectId(contestId);
  const recruiterAddProfilesCol = db.collection("recruiterAddProfiles");
  const recruiterProfileCol = db.collection("recruiterProfile");
  
  const recruiterDocs = await recruiterAddProfilesCol
    .find({ contestId: objectIdContestId })
    .toArray();

  const results = [];
  for (const rec of recruiterDocs) {
    const recruiterId = rec.recruiterId;
    let recruiterIdQuery = recruiterId;
    if (!(recruiterId instanceof ObjectId) && ObjectId.isValid(recruiterId)) {
      recruiterIdQuery = new ObjectId(recruiterId);
    }
    const recruiterProfile = await recruiterProfileCol.findOne(
      { _id: recruiterIdQuery },
      {
        projection: {
          "basic_details.firstName": 1,
          "basic_details.lastName": 1,
        },
      }
    );
    const recruiterName = recruiterProfile
      ? `${recruiterProfile.basic_details?.firstName || ""} ${
          recruiterProfile.basic_details?.lastName || ""
        }`.trim()
      : "Unknown Recruiter";
    const jobseekers = rec.jobseekerDetails || [];
    const profilesSubmitted = jobseekers.length;
    const profilesShortlisted = jobseekers.filter(
      (js) => js.empStatus?.toLowerCase() === "shortlisted"
    ).length;
    const profilesL1 = jobseekers.filter(
      (js) => js.empStatus?.toLowerCase() === "l1"
    ).length;
    const submissionRatio =
      profilesSubmitted > 0
        ? ((profilesL1 / profilesSubmitted) * 100).toFixed(2)
        : "0.00";
    results.push({
      recruiterName,
      profilesSubmitted,
      profilesShortlisted,
      profilesL1,
      submissionRatio: `${submissionRatio}%`,
    });
  }
  return results;
}

async function getOverallStatsData(contestId) {
  const recruiterAddProfilesCol = db.collection("recruiterAddProfiles");
  const matchCondition = ObjectId.isValid(contestId)
    ? {
        $or: [
          { contestId: new ObjectId(contestId) }, 
          { "contestId.$oid": contestId },        
          { contestId: contestId }                
        ]
      }
    : { contestId };

  const stats = await recruiterAddProfilesCol.aggregate([
    { $match: matchCondition },
    { $unwind: "$jobseekerDetails" },
    {
      $group: {
        _id: null,
        totalSubmittedProfiles: { $sum: 1 },
        totalApplied: {
          $sum: {
            $cond: [
              { $eq: [{ $toLower: "$jobseekerDetails.status" }, "submitted"] },
              1, 0
            ]
          }
        },
        totalShortlisted: {
          $sum: {
            $cond: [
              { $eq: [{ $toLower: "$jobseekerDetails.empStatus" }, "shortlisted"] },
              1, 0
            ]
          }
        },
        totalL1: {
          $sum: {
            $cond: [
              { $eq: [{ $toLower: "$jobseekerDetails.empStatus" }, "l1"] },
              1, 0
            ]
          }
        },
        totalL2: {
          $sum: {
            $cond: [
              { $eq: [{ $toLower: "$jobseekerDetails.empStatus" }, "l2"] },
              1, 0
            ]
          }
        },
        totalL3: {
          $sum: {
            $cond: [
              { $eq: [{ $toLower: "$jobseekerDetails.empStatus" }, "l3"] },
              1, 0
            ]
          }
        },
        totalHR: {
          $sum: {
            $cond: [
              { $eq: [{ $toLower: "$jobseekerDetails.empStatus" }, "hr"] },
              1, 0
            ]
          }
        },
        totalOfferSent: {
          $sum: {
            $cond: [
              { $eq: [{ $toLower: "$jobseekerDetails.empStatus" }, "offersent"] },
              1, 0
            ]
          }
        }
      }
    },
    {
      $project: {
        _id: 0,
        totalSubmittedProfiles: 1,
        totalApplied: 1,
        totalShortlisted: 1,
        totalL1: 1,
        totalL2: 1,
        totalL3: 1,
        totalHR: 1,
        totalOfferSent: 1
      }
    }
  ]).toArray();

  return stats.length ? stats[0] : null;
}

async function processContestAnalytics(contestId) {
  try {
    console.log('Processing contest analytics for:', contestId);
    
    const [lifecycleData, recruiterData, overallData] = await Promise.all([
      getContestLifeCycleData(contestId),
      getRecruiterStatsData(contestId),
      getOverallStatsData(contestId)
    ]);

    if (!lifecycleData.length && !recruiterData.length && !overallData) {
      return {
        success: false,
        error: 'No data found for the given contestId'
      };
    }

    const lifecycleText = lifecycleData.length 
      ? lifecycleData.map(doc => {
          const date = new Date(doc.createdDate).toLocaleDateString();
          return `${date}: ${doc.action} by ${doc.userName} (${doc.userRole}) - ${doc.comment}`;
        }).join('; ')
      : 'No lifecycle data available';

    const recruiterSummary = recruiterData.length 
      ? recruiterData.map(r => `${r.recruiterName}: ${r.profilesSubmitted} submitted, ${r.profilesShortlisted} shortlisted, ${r.profilesL1} L1, ratio ${r.submissionRatio}`).join('; ')
      : 'No recruiter data available';

    const funnelSummary = overallData 
      ? `Total: ${overallData.totalSubmittedProfiles} submitted, ${overallData.totalShortlisted} shortlisted, ${overallData.totalL1} L1, ${overallData.totalL2} L2, ${overallData.totalL3} L3, ${overallData.totalHR} HR, ${overallData.totalOfferSent} offers sent`
      : 'No funnel data available';

    const prompt = `
You are an expert contest analytics consultant. Analyze the comprehensive contest data and provide detailed insights across all dimensions.

CONTEST COMPREHENSIVE ANALYSIS:
Contest ID: ${contestId}

LIFECYCLE DATA:
${lifecycleText}

RECRUITER PERFORMANCE DATA:
${recruiterSummary}

CANDIDATE FUNNEL DATA:
${funnelSummary}

REQUIREMENTS:
Provide analysis in this EXACT JSON format only, no additional text:

{
    "contest-lifecycle": {
        "summary": "[30-40 words summary of contest lifecycle progression and current status]",
        "detailedAnalysis": "[80-100 words detailed analysis of lifecycle patterns, stakeholder involvement, and decision points]",
        "currentStatus": "[15-20 words current state based on latest action]"
    },
    "candidate-funnel-analysis": {
        "summary": "[30-40 words summary of candidate progression through hiring stages]",
        "detailedAnalysis": "[80-100 words analysis of conversion rates, bottlenecks, and funnel efficiency]"
    },
    "recruiter-performance": {
        "summary": "[30-40 words summary of recruiter effectiveness and submission quality]",
        "detailedAnalysis": "[80-100 words analysis of individual recruiter performance, ratios, and contribution patterns]"
    },
    "overall-ai-powered-insights-and-recommendations": {
        "summary": "[40-50 words comprehensive summary combining all aspects]",
        "recommendations": "[60-80 words specific actionable recommendations for improvement across all areas]"
    }
}

Focus on:
- Lifecycle progression and current contest status
- Candidate conversion rates and funnel optimization
- Recruiter performance differences and efficiency
- Integrated recommendations for overall improvement
- Don't show contest id in the summary or any where 

Return ONLY the JSON object, no other text.
`;

    const response = await axios.post(API_URL, {
      model: 'mistral-small',
      messages: [{
        role: 'user',
        content: prompt
      }],
      max_tokens: 800,
      temperature: 0.4
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MISTRAL_API_KEY}`
      }
    });

    const aiResponse = response.data.choices[0].message.content.trim();
    
    let mistralAnalysis;
    
    try {
      mistralAnalysis = JSON.parse(aiResponse);
    } catch (parseError) {
      console.error('Error parsing AI response as JSON:', parseError);
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          mistralAnalysis = JSON.parse(jsonMatch[0]);
        } catch (secondParseError) {
          mistralAnalysis = {
            "contest-lifecycle": {
              "summary": "Contest lifecycle analysis completed with stakeholder actions recorded, showing progression through multiple stages with active management.",
              "detailedAnalysis": "Unable to parse AI analysis response due to formatting issues. Contest shows activity from multiple stakeholders with various actions recorded.",
              "currentStatus": "Analysis parsing failed - manual review required"
            },
            "candidate-funnel-analysis": {
              "summary": "Candidate funnel shows progression through hiring stages with conversion tracking across multiple interview levels.",
              "detailedAnalysis": "Funnel analysis indicates candidate flow from application to offer stage with measurable conversion rates at each step."
            },
            "recruiter-performance": {
              "summary": "Recruiter performance varies across submissions with different efficiency ratios and contribution patterns observed.",
              "detailedAnalysis": "Individual recruiter analysis shows varying submission quality and conversion rates requiring targeted performance improvement."
            },
            "overall-ai-powered-insights-and-recommendations": {
              "summary": "Contest shows active management with stakeholder involvement and candidate progression through structured hiring funnel.",
              "recommendations": "Implement standardized performance metrics, optimize funnel conversion rates, and enhance recruiter training programs."
            }
          };
        }
      }
    }

    return {
      success: true,
      status: 200,
      contestId,
      aiAnalysis: mistralAnalysis,
      rawData: {
        lifecycleEvents: lifecycleData.length,
        recruitersCount: recruiterData.length,
        totalCandidates: overallData?.totalSubmittedProfiles || 0
      },
      generatedAt: new Date().toISOString()
    };

  } catch (error) {
    console.error('Error in processContestAnalytics:', error);
    return {
      success: false,
      error: 'Failed to generate contest analytics',
      details: error.message
    };
  }
}

app.post('/contestAnalytics', async (req, res) => {
  try {
    const { contestId } = req.body;
    
    if (!contestId) {
      return res.status(400).json({
        success: false,
        error: 'Contest ID is required'
      });
    }

    if (!ObjectId.isValid(contestId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Contest ID format'
      });
    }

    const result = await processContestAnalytics(contestId);
    
    if (!result.success) {
      return res.status(404).json(result);
    }
    
    res.json(result);
    
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate contest analytics',
      details: error.message
    });
  }
});

app.get('/debug-contest-data/:contestId', async (req, res) => {
  try {
    const { contestId } = req.params;
    
    if (!ObjectId.isValid(contestId)) {
      return res.json({ error: 'Invalid ObjectId format' });
    }

    const [lifecycleData, recruiterData, overallData] = await Promise.all([
      getContestLifeCycleData(contestId),
      getRecruiterStatsData(contestId),
      getOverallStatsData(contestId)
    ]);

    res.json({
      contestId,
      lifecycleEvents: lifecycleData.length,
      recruiterCount: recruiterData.length,
      overallStats: overallData,
      sampleData: {
        lifecycle: lifecycleData.slice(0, 2),
        recruiters: recruiterData.slice(0, 2)
      }
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Contest Analytics API is running',
    database: DB_NAME,
    endpoints: {
      main: '/contestAnalytics',
      debug: '/debug-contest-data/:contestId',
      health: '/health'
    }
  });
});

connectToDatabase();

app.listen(PORT, () => {
  console.log(`Contest Analytics API running on port ${PORT}`);
  console.log(`Main endpoint: POST /contestAnalytics`);
  console.log(`Health check: GET /health`);
});
