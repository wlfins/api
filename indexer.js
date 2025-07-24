require('dotenv').config();
const { ethers } = require("ethers");
const { getDB } = require('./mongo');

// --- Configuration ---
const RPC_URL = process.env.MAINNET_RPC_URL;
const REGISTRAR_ADDR = process.env.REGISTRAR_ADDR;
const RESOLVER_ADDR = process.env.RESOLVER_ADDR;
const WLFIREGISTRY_ADDR = process.env.WLFIREGISTRY_ADDR;
const DEPLOYMENT_BLOCK = parseInt(process.env.DEPLOYMENT_BLOCK) || 0;

const REGISTRAR_ABI = [
    "event DomainRenewed(string name, address owner, uint256 expires)"
];

const RESOLVER_ABI = [
    "event TextChanged(bytes32 indexed node, string indexed indexedKey, string key, string value)"
];

const WLFIREGISTRY_ABI = [
    "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
    "event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)",
    "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)"
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
    const wlfirRegistry = new ethers.Contract(WLFIREGISTRY_ADDR, WLFIREGISTRY_ABI, provider);

    // --- Historical Event Processing ---
    console.log("Processing historical events...");
    const BLOCK_CHUNK_SIZE = 1000; // Process events in chunks of 1,000 blocks (RPC limit)
    const currentBlock = await provider.getBlockNumber();
    let processedEventsCount = 0;

    for (let i = DEPLOYMENT_BLOCK; i <= currentBlock; i += BLOCK_CHUNK_SIZE) {
        const fromBlock = i;
        const toBlock = Math.min(i + BLOCK_CHUNK_SIZE - 1, currentBlock);
        console.log(`Querying blocks ${fromBlock} to ${toBlock} for events...`);

        const transferFilter = wlfirRegistry.filters.Transfer();
        const pastTransferEvents = await wlfirRegistry.queryFilter(transferFilter, fromBlock, toBlock);

        for (const event of pastTransferEvents) {
            if (!event.args) {
                console.error("Skipping malformed historical Transfer event: event.args is undefined.", event);
                continue;
            }
            const [from, to, tokenId] = event.args;
            console.log(`[HISTORICAL] Found Transfer: ${tokenId} to ${to} at block ${event.blockNumber}`);
            await updateDatabase(tokenId.toString(), { owner: to }, false);
            processedEventsCount++;
        }
    }
    console.log(`Finished processing ${processedEventsCount} historical transfer events.`);

    // --- Live Event Listeners ---
    console.log("Attaching live event listeners...");

    wlfirRegistry.on("Transfer", async (...args) => {
        const [from, to, tokenId] = args;
        if (!from || !to || !tokenId) {
            console.error("Skipping malformed live Transfer event: args are undefined.", args);
            return;
        }
        try {
            console.log(`[LIVE] Transfer: ${tokenId} from ${from} to ${to}`);
            await updateDatabase(tokenId.toString(), { owner: to });
        } catch (error) {
            console.error("Error processing live Transfer event:", error);
        }
    });

    registrar.on("DomainRenewed", async (name, owner, expires) => {
        try {
            console.log(`[LIVE] Domain Renewed: ${name}`);
            const hexTokenId = ethers.namehash(name);
            const tokenId = BigInt(hexTokenId).toString();
            await updateDatabase(tokenId, { expiry: expires.toString() });
        } catch (error) {
            console.error("Error processing live DomainRenewed event:", error);
        }
    });

    resolver.on("TextChanged", async (node, indexedKey, key, value) => {
        try {
            console.log(`[LIVE] Text Record Changed for node ${node}`);
            const tokenId = BigInt(node).toString(); // In our system, the node is the hex tokenId
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