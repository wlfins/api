require('dotenv').config();
const { ethers } = require("ethers");
const { getDB } = require('./mongo');

// --- Configuration ---
const RPC_URL = process.env.MAINNET_RPC_URL;
const REGISTRAR_ADDR = process.env.REGISTRAR_ADDR;
const RESOLVER_ADDR = process.env.RESOLVER_ADDR;
const DEPLOYMENT_BLOCK = parseInt(process.env.DEPLOYMENT_BLOCK) || 0; // Add the block number when the Registrar was deployed

const REGISTRAR_ABI = [
    "event DomainRegistered(string name, address owner, uint256 expires)",
    "event DomainRenewed(string name, address owner, uint256 expires)"
];

const RESOLVER_ABI = [
    "event TextChanged(bytes32 indexed node, string indexed indexedKey, string key, string value)"
];

// --- Main Logic ---
async function main() {
    console.log("Starting indexer...");

    console.log("Connecting to provider...");
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    // Wait for the provider to be fully connected
    let blockNumber = -1;
    while (blockNumber < 0) {
        try {
            blockNumber = await provider.getBlockNumber();
            console.log("Provider connected. Current block:", blockNumber);
        } catch (e) {
            console.log("Waiting for provider connection...");
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    const registrar = new ethers.Contract(REGISTRAR_ADDR, REGISTRAR_ABI, provider);
    const resolver = new ethers.Contract(RESOLVER_ADDR, RESOLVER_ABI, provider);

    // --- Historical Event Processing ---
    console.log("Processing historical DomainRegistered events...");
    const registeredFilter = registrar.filters.DomainRegistered();
    const pastRegisteredEvents = await registrar.queryFilter(registeredFilter, DEPLOYMENT_BLOCK, 'latest');

    for (const event of pastRegisteredEvents) {
        const [name, owner, expires] = event.args;
        console.log(`[HISTORICAL] Found DomainRegistered: ${name}`);
        const tokenId = ethers.namehash(name);
        await updateDatabase(tokenId, { name, owner, expiry: expires.toString() }, false); // Don't log every historical update
    }
    console.log(`Finished processing ${pastRegisteredEvents.length} historical registration events.`);

    // --- Live Event Listeners ---
    console.log("Attaching live event listeners...");

    registrar.on("DomainRegistered", async (name, owner, expires) => {
        try {
            console.log(`[LIVE] New Domain Registered: ${name}`);
            const tokenId = ethers.namehash(name);
            await updateDatabase(tokenId, { name, owner, expiry: expires.toString() });
        } catch (error) {
            console.error("Error processing live DomainRegistered event:", error);
        }
    });

    registrar.on("DomainRenewed", async (name, owner, expires) => {
        try {
            console.log(`[LIVE] Domain Renewed: ${name}`);
            const tokenId = ethers.namehash(name);
            await updateDatabase(tokenId, { expiry: expires.toString() });
        } catch (error) {
            console.error("Error processing live DomainRenewed event:", error);
        }
    });

    resolver.on("TextChanged", async (node, indexedKey, key, value) => {
        try {
            console.log(`[LIVE] Text Record Changed for node ${node}`);
            const tokenId = node; // In our system, the node is the tokenId
            const keyMap = {
                "description": "description",
                "avatar": "avatar",
                "x": "xUsername"
            };
            const dbKey = keyMap[key];
            if (dbKey) {
                await updateDatabase(tokenId, { [dbKey]: value });
            }
        } catch (error) {
            console.error("Error processing live TextChanged event:", error);
        }
    });

    console.log("Listening for live events...");
}

// --- Database Helper ---
async function updateDatabase(tokenId, newData, log = true) {
    try {
        const db = await getDB();
        const result = await db.collection('domains').updateOne(
            { tokenId: tokenId },
            { $set: newData },
            { upsert: true }
        );
        if (log) {
            console.log(`Database updated for token ID: ${tokenId}. Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}, Upserted: ${result.upsertedCount}`);
        }
    } catch (err) {
        console.error("Error writing to database:", err);
    }
}

main().catch(error => {
    console.error("Unhandled error in indexer:", error);
    process.exit(1);
});
