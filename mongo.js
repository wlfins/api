const { MongoClient, ServerApiVersion } = require('mongodb');
const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

let db;

async function connectToServer() {
  try {
    await client.connect();
    db = client.db('wlfins');
    console.log("Successfully connected to MongoDB!");
  } catch (err) {
    console.error("Failed to connect to MongoDB", err);
    process.exit(1);
  }
}

const getDB = () => {
    if (!db) {
        throw new Error("Must connect to database first.");
    }
    return db;
};

module.exports = { connectToServer, getDB };