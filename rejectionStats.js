const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = "Marketplace-ifin";

let db;

async function connectToDatabase() {
    if (db) return db;
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db(DB_NAME);
        return db;
    } catch (error) {
        console.error('FATAL: Could not connect to MongoDB.', error);
        process.exit(1);
    }
}

async function analyzeRejectionReasons(contestId) {
    try {
        const collection = db.collection('recruiterAddProfiles');
        const contestObjectId = new ObjectId(contestId);

        const contestDocument = await collection.findOne({ contestId: contestObjectId });
        if (!contestDocument) {
            const error = new Error('Contest not found.');
            error.statusCode = 404;
            throw error;
        }

        const totalParticipants = Array.isArray(contestDocument.jobseekerDetails) ? contestDocument.jobseekerDetails.length : 0;

        const pipeline = [
            {
                $match: {
                    contestId: contestObjectId,
                }
            },
            {
                $unwind: "$jobseekerDetails"
            },
            {
                $match: {
                    'jobseekerDetails.empStatus': { $in: ['rejected', 'Rejected'] }
                }
            },
            {
                $group: {
                    _id: null,
                    rejectionTotalCount: { $sum: 1 },
                    primarySkillsCount: {
                        $sum: { $cond: [{ $regexMatch: { input: '$jobseekerDetails.rejectedReason', regex: /skill/i } }, 1, 0] }
                    },
                    experienceYearsCount: {
                        $sum: { $cond: [{ $regexMatch: { input: '$jobseekerDetails.rejectedReason', regex: /experience/i } }, 1, 0] }
                    },
                    expectedCTCCount: {
                        $sum: { $cond: [{ $regexMatch: { input: '$jobseekerDetails.rejectedReason', regex: /ctc|salary|budget/i } }, 1, 0] }
                    }
                }
            }
        ];

        const aggregationResult = await collection.aggregate(pipeline).toArray();

        let analysis = {
            rejectionTotalCount: 0,
            primarySkills: 0,
            experienceYears: 0,
            expectedCTC: 0,
            recruiterRatingComments: 0
        };

        if (aggregationResult.length > 0) {
            const result = aggregationResult[0];
            const categorizedCount = result.primarySkillsCount + result.experienceYearsCount + result.expectedCTCCount;

            analysis = {
                rejectionTotalCount: result.rejectionTotalCount,
                primarySkills: result.primarySkillsCount,
                experienceYears: result.experienceYearsCount,
                expectedCTC: result.expectedCTCCount,
                recruiterRatingComments: result.rejectionTotalCount - categorizedCount
            };
        }

        return {
            totalCandidatesParticipated: totalParticipants,
            ...analysis
        };

    } catch (error) {
        console.error('Error during rejection analysis:', error);
        throw error;
    }
}

app.get('/analysis/rejections/:contestId', async (req, res) => {
    const { contestId } = req.params;

    if (!ObjectId.isValid(contestId)) {
        return res.status(400).json({ error: 'Invalid Contest ID format.' });
    }

    try {
        const report = await analyzeRejectionReasons(contestId);
        res.status(200).json(report);
    } catch (error) {
        const statusCode = error.statusCode || 500;
        res.status(statusCode).json({ error: error.message });
    }
});

async function startServer() {
    if (!MONGODB_URI) {
        console.error('Error: MONGODB_URI is not defined in the .env file.');
        process.exit(1);
    }
    await connectToDatabase();
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
    });
}

startServer();
