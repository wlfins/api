require('dotenv').config();
const { ethers } = require("ethers");
const { connectToServer, getDB } = require('./mongo');

// --- Configuration ---
const RPC_URL = process.env.MAINNET_RPC_URL;
const REGISTRAR_ADDR = process.env.REGISTRAR_ADDR;
const RESOLVER_ADDR = process.env.RESOLVER_ADDR;
const WLFIREGISTRY_ADDR = process.env.WLFIREGISTRY_ADDR;
const DEPLOYMENT_BLOCK = parseInt(process.env.DEPLOYMENT_BLOCK) || 0;

const REGISTRAR_ABI = [
    "event DomainRegistered(string name, address owner, uint256 expires)",
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

    await connectToServer();

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
    let processedTransferEvents = 0;
    let processedRenewalEvents = 0;
    let processedRegistrationEvents = 0;

    for (let i = DEPLOYMENT_BLOCK; i <= currentBlock; i += BLOCK_CHUNK_SIZE) {
        const fromBlock = i;
        const toBlock = Math.min(i + BLOCK_CHUNK_SIZE - 1, currentBlock);
        console.log(`Querying blocks ${fromBlock} to ${toBlock} for events...`);

        // Transfers
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
            processedTransferEvents++;
        }

        // Registrations
        const domainRegisteredFilter = registrar.filters.DomainRegistered();
        const pastRegisteredEvents = await registrar.queryFilter(domainRegisteredFilter, fromBlock, toBlock);

        for (const event of pastRegisteredEvents) {
            if (!event.args) {
                console.error("Skipping malformed historical DomainRegistered event: event.args is undefined.", event);
                continue;
            }
            const { name, owner, expires } = event.args;
            const hexTokenId = ethers.namehash(name);
            const tokenId = BigInt(hexTokenId).toString();
            console.log(`[HISTORICAL] Found DomainRegistered: ${name} (Token ID: ${tokenId}) at block ${event.blockNumber}`);
            await updateDatabase(tokenId, { name: name, owner: owner, expiry: expires.toString() }, false);
            processedRegistrationEvents++;
        }

        // Renewals
        const domainRenewedFilter = registrar.filters.DomainRenewed();
        const pastRenewedEvents = await registrar.queryFilter(domainRenewedFilter, fromBlock, toBlock);

        for (const event of pastRenewedEvents) {
            if (!event.args) {
                console.error("Skipping malformed historical DomainRenewed event: event.args is undefined.", event);
                continue;
            }
            const { name, owner, expires } = event.args;
            const hexTokenId = ethers.namehash(name);
            const tokenId = BigInt(hexTokenId).toString();
            console.log(`[HISTORICAL] Found DomainRenewed: ${name} (Token ID: ${tokenId}) at block ${event.blockNumber}`);
            await updateDatabase(tokenId, { name: name, expiry: expires.toString() }, false);
            processedRenewalEvents++;
        }

        // TextChanged (Metadata)
        const textChangedFilter = resolver.filters.TextChanged();
        const pastTextChangedEvents = await resolver.queryFilter(textChangedFilter, fromBlock, toBlock);

        for (const event of pastTextChangedEvents) {
            if (!event.args) {
                console.error("Skipping malformed historical TextChanged event: event.args is undefined.", event);
                continue;
            }
            const { node, indexedKey, key, value } = event.args;
            const tokenId = BigInt(node).toString();
            const keyMap = {
                "description": "description",
                "avatar": "avatar",
                "url": "website",
                "x": "xUsername",
                "com.github": "github",
                "com.telegram": "telegram",
                "com.discord": "discord"
            };
            const dbKey = keyMap[key];
            if (dbKey) {
                console.log(`[HISTORICAL] Found TextChanged for ${key} on token ${tokenId} at block ${event.blockNumber}`);
                await updateDatabase(tokenId, { [dbKey]: value }, false);
            }
        }
    }
    console.log(`Finished processing ${processedTransferEvents} historical transfer events.`);
    console.log(`Finished processing ${processedRegistrationEvents} historical registration events.`);
    console.log(`Finished processing ${processedRenewalEvents} historical renewal events.`);


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

    registrar.on("DomainRegistered", async (name, owner, expires) => {
        try {
            console.log(`[LIVE] Domain Registered: ${name}`);
            const hexTokenId = ethers.namehash(name);
            const tokenId = BigInt(hexTokenId).toString();
            await updateDatabase(tokenId, { name: name, owner: owner, expiry: expires.toString() });
        } catch (error) {
            console.error("Error processing live DomainRegistered event:", error);
        }
    });

    registrar.on("DomainRenewed", async (name, owner, expires) => {
        try {
            console.log(`[LIVE] Domain Renewed: ${name}`);
            const hexTokenId = ethers.namehash(name);
            const tokenId = BigInt(hexTokenId).toString();
            await updateDatabase(tokenId, { name: name, expiry: expires.toString() });
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
                "url": "website",
                "x": "xUsername",
                "com.github": "github",
                "com.telegram": "telegram",
                "com.discord": "discord"
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
        const db = getDB();
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