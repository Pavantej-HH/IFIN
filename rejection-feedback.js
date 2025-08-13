const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const API_URL = 'https://api.mistral.ai/v1/chat/completions';
const DB_NAME = 'Marketplace-ifin';
const COLLECTION_NAME = 'recruiterAddProfiles';

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

async function processRejectionFeedbackObservation(contestId) {
  try {
    console.log('Searching for contestId:', contestId);
    
    const objectIdContestId = new ObjectId(contestId);
    
    const contestCheck = await db.collection(COLLECTION_NAME)
      .findOne({ contestId: objectIdContestId });
    
    if (!contestCheck) {
      console.log('Contest not found with this ID');
      return {
        success: false,
        error: 'Contest not found with this ID'
      };
    }
    
    console.log('Contest found, checking jobseekerDetails...');
    
    const debugPipeline = [
      { $match: { contestId: objectIdContestId } },
      { $unwind: "$jobseekerDetails" },
      { 
        $group: { 
          _id: "$jobseekerDetails.empStatus",
          count: { $sum: 1 }
        }
      }
    ];
    
    const statusCounts = await db.collection(COLLECTION_NAME)
      .aggregate(debugPipeline)
      .toArray();
    
    console.log('All empStatus values found:');
    statusCounts.forEach(status => {
      console.log(`   ${status._id}: ${status.count} candidates`);
    });
    
    const pipeline = [
      {
        $match: { contestId: objectIdContestId }
      },
      {
        $unwind: "$jobseekerDetails"
      },
      {
        $match: {
          "jobseekerDetails.empStatus": "Rejected"
        }
      },
      {
        $project: {
          _id: 1,
          contestId: 1,
          "jobseekerDetails": 1
        }
      }
    ];
    
    const rejectedProfiles = await db.collection(COLLECTION_NAME)
      .aggregate(pipeline)
      .toArray();

    console.log(`Found ${rejectedProfiles.length} rejected profiles`);
    
    if (rejectedProfiles.length === 0) {
      return {
        success: true,
        contestId,
        message: 'No rejected candidates found for this contest',
        totalRejected: 0,
        aiAnalysis: {
          "observation": "No rejected candidates were found for this contest, indicating either successful candidate selection or insufficient data for analysis. This could suggest effective initial screening processes or a limited candidate pool that met all requirements.",
          "recommendedAction": "Continue monitoring future contests for rejection patterns and maintain current screening standards while expanding candidate sourcing to increase applicant diversity and selection options."
        }
      };
    }

    const reasonCounts = {};
    const totalRejected = rejectedProfiles.length;
    
    console.log('Analyzing rejection reasons for', totalRejected, 'profiles');
    
    if (rejectedProfiles.length > 0) {
      console.log('Sample profile structure:', JSON.stringify(rejectedProfiles[0], null, 2));
    }
    
    const scores = rejectedProfiles.map(profile => profile.jobseekerDetails?.scores || null);
    const scoresJson = JSON.stringify(scores);
    
    rejectedProfiles.forEach((profile, index) => {
      let reason = 'Unknown';
      
      const possiblePaths = [
        profile.jobseekerDetails?.remarks?.rejectedReason,
        profile.jobseekerDetails?.rejectedReason,
        profile.jobseekerDetails?.rejectionReason,
        profile.jobseekerDetails?.remarks?.reason,
        profile.jobseekerDetails?.reason,
        profile.jobseekerDetails?.comments,
        profile.jobseekerDetails?.feedback,
        profile.rejectedReason,
        profile.rejectionReason
      ];
      
      for (const path of possiblePaths) {
        if (path && path !== 'undefined' && path.trim() !== '') {
          reason = path;
          break;
        }
      }
      
      console.log(`Profile ${index + 1} - Found rejection reason:`, reason);
      
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    });
    
    const reasonAnalysis = Object.entries(reasonCounts)
      .map(([reason, count]) => ({
        reason,
        count,
        percentage: ((count / totalRejected) * 100).toFixed(1)
      }))
      .sort((a, b) => b.count - a.count);
    
    const analysisData = {
      totalRejected,
      reasonAnalysis,
      topReasons: reasonAnalysis.slice(0, 5),
      scores: scoresJson
    };

    const { topReasons } = analysisData;
    
    const reasonsText = topReasons
      .map(item => `${item.reason}: ${item.count} candidates (${item.percentage}%)`)
      .join('\n');
    
    const prompt = `
You are an expert HR analytics consultant. Analyze the following contest rejection data and provide comprehensive insights with actionable recommendations.

CONTEST REJECTION ANALYSIS:
Contest ID: ${contestId}
Total Rejected Candidates: ${totalRejected}

TOP REJECTION REASONS:
${reasonsText}

SCORES:
${scoresJson}

REQUIREMENTS:
Provide analysis in this EXACT JSON format only, no additional text:

{
    "observation": "[Detailed analysis of rejection patterns with specific percentages, trends, and implications for the hiring process, Don't give the response in points  - MINIMUM 60-80 words]",
    "recommendedAction": "[Comprehensive, actionable recommendations with specific steps, timelines, and implementation strategies, Don't give the response in points  - MINIMUM 40-50 words]"
}

OBSERVATION REQUIREMENTS (60-80 words minimum):
- Include specific percentage breakdowns and statistical insights
- Analyze patterns and trends in the rejection data
- Reference score analysis if available
- Discuss implications for recruitment strategy
- Identify root causes and systemic issues
- Compare against industry standards
- Don't give the response in points 

RECOMMENDED ACTION REQUIREMENTS (40-50 words minimum):
- Provide specific, implementable steps
- Suggest tools, technologies, or processes
- Address both immediate fixes and long-term improvements
- Don't give the response in points 

Focus on:
1. Most significant rejection reasons and their impact on hiring efficiency
2. Score patterns and correlation with rejection outcomes
3. Skills, experience, qualification, and communication mismatches
4. Systematic improvements to reduce future rejections

Keep analysis data-driven and actionable. Each recommendation should be specific and implementable.
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
      console.log('Raw AI response:', aiResponse);
      
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          mistralAnalysis = JSON.parse(jsonMatch[0]);
        } catch (secondParseError) {
          console.error('Second JSON parse attempt failed:', secondParseError);
          mistralAnalysis = {
            "observation": "Unable to parse AI analysis response due to formatting issues. The rejection analysis shows patterns that require manual review to identify specific improvement areas and understand the underlying causes affecting candidate selection processes.",
            "recommendedAction": "Please retry the analysis or manually review the rejection data to implement targeted improvements in the recruitment process, focusing on systematic evaluation of rejection patterns and candidate feedback mechanisms."
          };
        }
      } else {
        mistralAnalysis = {
          "observation": "AI response could not be parsed into the expected JSON format. The rejection data suggests systematic issues that need detailed analysis to understand root causes and develop comprehensive improvement strategies for the recruitment workflow.",
          "recommendedAction": "Contact technical support to resolve AI parsing issues and manually analyze rejection patterns to implement immediate process improvements while ensuring data integrity and analysis accuracy."
        };
      }
    }

    // Return comprehensive result
    return {
      success: true,
      contestId,
      totalRejected: analysisData.totalRejected,
      rejectionBreakdown: analysisData.reasonAnalysis,
      aiAnalysis: mistralAnalysis,
      generatedAt: new Date().toISOString()
    };

  } catch (error) {
    console.error('Error in processRejectionFeedbackObservation:', error);
    
    return {
      success: false,
      error: 'Failed to generate rejection feedback observation',
      details: error.message,
      aiAnalysis: {
        "observation": "An error occurred during the rejection analysis process, preventing comprehensive insights generation. This may indicate data connectivity issues, database access problems, or service interruptions that need immediate technical attention to restore analytical capabilities.",
        "recommendedAction": "Check system connectivity, verify database access permissions, ensure all required services are operational, and review error logs before retrying the rejection analysis process to maintain data-driven recruitment insights."
      }
    };
  }
}

app.post('/rejectionFeedbackObservation', async (req, res) => {
  try {
    const { contestId } = req.body;
    
    if (!contestId) {
      return res.status(400).json({
        success: false,
        error: 'Contest ID is required',
        aiAnalysis: {
          "observation": "Contest ID parameter is missing from the request, which is essential for performing rejection analysis and accessing candidate data. This prevents the system from retrieving specific contest information and generating meaningful feedback insights.",
          "recommendedAction": "Ensure the request includes a valid contestId parameter and verify the request format matches the API specification. Implement proper input validation to prevent similar issues in future requests."
        }
      });
    }

    if (!ObjectId.isValid(contestId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Contest ID format',
        aiAnalysis: {
          "observation": "The provided Contest ID does not match the expected MongoDB ObjectId format, indicating potential data entry errors or system integration issues that prevent proper data retrieval and analysis processing.",
          "recommendedAction": "Validate the Contest ID format using MongoDB ObjectId standards and ensure proper data validation is implemented at the input level to prevent similar formatting issues and maintain data integrity."
        }
      });
    }

    const result = await processRejectionFeedbackObservation(contestId);
    res.json(result);
    
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate rejection feedback observation',
      details: error.message,
      aiAnalysis: {
        "observation": "A critical system error occurred during the rejection feedback observation process, indicating potential infrastructure issues, service connectivity problems, or resource limitations that require immediate technical intervention to restore functionality.",
        "recommendedAction": "Contact system administrators to investigate server status, check database connectivity, verify all dependent services are operational, and review system logs before attempting to retry the analysis process."
      }
    });
  }
});

app.get('/debug-contest-check/:contestId', async (req, res) => {
  try {
    const { contestId } = req.params;
    
    if (!ObjectId.isValid(contestId)) {
      return res.json({ error: 'Invalid ObjectId format' });
    }
    
    const objectIdContestId = new ObjectId(contestId);
    
    const contest = await db.collection(COLLECTION_NAME)
      .findOne({ contestId: objectIdContestId });
    
    if (!contest) {
      return res.json({
        found: false,
        message: 'Contest not found',
        searchedFor: contestId
      });
    }
    
    const statusPipeline = [
      { $match: { contestId: objectIdContestId } },
      { $unwind: "$jobseekerDetails" },
      { 
        $group: { 
          _id: "$jobseekerDetails.empStatus",
          count: { $sum: 1 },
          samples: { $push: "$jobseekerDetails.firstName" }
        }
      }
    ];
    
    const statuses = await db.collection(COLLECTION_NAME)
      .aggregate(statusPipeline)
      .toArray();
    
    res.json({
      found: true,
      contestId,
      totalCandidates: contest.jobseekerDetails?.length || 0,
      empStatusBreakdown: statuses,
      sampleDocument: {
        _id: contest._id,
        contestId: contest.contestId,
        jobseekerDetailsCount: contest.jobseekerDetails?.length || 0
      }
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/debug-rejected/:contestId', async (req, res) => {
  try {
    const { contestId } = req.params;
    const objectIdContestId = new ObjectId(contestId);
    
    const pipeline = [
      { $match: { contestId: objectIdContestId } },
      { $unwind: "$jobseekerDetails" },
      { $match: { "jobseekerDetails.empStatus": "Rejected" } },
      { $limit: 2 }
    ];
    
    const rejected = await db.collection(COLLECTION_NAME)
      .aggregate(pipeline)
      .toArray();
    
    res.json({
      contestId,
      count: rejected.length,
      fullDocuments: rejected
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Rejection Feedback Observation API is running',
    database: DB_NAME,
    collection: COLLECTION_NAME,
    endpoints: {
      main: '/rejectionFeedbackObservation',
      debug: ['/debug-contest-check/:contestId', '/debug-rejected/:contestId'],
      health: '/health'
    }
  });
});

connectToDatabase();

app.listen(PORT, () => {
  console.log(`Rejection Feedback Observation API running on port ${PORT}`);
  console.log(`Main endpoint: POST /rejectionFeedbackObservation`);
  console.log(`Health check: GET /health`);
});
