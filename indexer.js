
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
];

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

async function getAndSetLastProcessedBlock(db, newBlockNumber = null) {
    const collection = db.collection('indexer_state');
    if (newBlockNumber !== null) {
        await collection.updateOne({}, { $set: { lastProcessedBlock: newBlockNumber } }, { upsert: true });
        return newBlockNumber;
    } else {
        const state = await collection.findOne({});
        return state ? state.lastProcessedBlock : DEPLOYMENT_BLOCK;
    }
}


module.exports = async (req, res) => {
    console.log("Indexer function invoked.");

    // --- Security Check ---
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        console.log("Unauthorized access attempt.");
        return res.status(401).send('Unauthorized');
    }

    try {
        await connectToServer();
        const db = getDB();

        console.log("Connecting to provider...");
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        await provider.ready;
        console.log("Provider connected.");

        const registrar = new ethers.Contract(REGISTRAR_ADDR, REGISTRAR_ABI, provider);
        const resolver = new ethers.Contract(RESOLVER_ADDR, RESOLVER_ABI, provider);
        const wlfirRegistry = new ethers.Contract(WLFIREGISTRY_ADDR, WLFIREGISTRY_ABI, provider);

        const currentBlock = await provider.getBlockNumber();
        let lastProcessedBlock = await getAndSetLastProcessedBlock(db);

        console.log(`Processing events from block ${lastProcessedBlock} to ${currentBlock}`);

        if (lastProcessedBlock >= currentBlock) {
            console.log("No new blocks to process.");
            res.status(200).send("No new blocks to process.");
            return;
        }

        const BLOCK_CHUNK_SIZE = 1000; 
        let processedTransferEvents = 0;
        let processedRenewalEvents = 0;
        let processedRegistrationEvents = 0;
        let processedTextChangedEvents = 0;


        for (let i = lastProcessedBlock + 1; i <= currentBlock; i += BLOCK_CHUNK_SIZE) {
            const fromBlock = i;
            const toBlock = Math.min(i + BLOCK_CHUNK_SIZE - 1, currentBlock);
            console.log(`Querying blocks ${fromBlock} to ${toBlock} for events...`);

            // Transfers
            const transferFilter = wlfirRegistry.filters.Transfer();
            const pastTransferEvents = await wlfirRegistry.queryFilter(transferFilter, fromBlock, toBlock);

            for (const event of pastTransferEvents) {
                if (!event.args) continue;
                const [from, to, tokenId] = event.args;
                console.log(`Found Transfer: ${tokenId} to ${to} at block ${event.blockNumber}`);
                await updateDatabase(tokenId.toString(), { owner: to }, false);
                processedTransferEvents++;
            }

            // Registrations
            const domainRegisteredFilter = registrar.filters.DomainRegistered();
            const pastRegisteredEvents = await registrar.queryFilter(domainRegisteredFilter, fromBlock, toBlock);

            for (const event of pastRegisteredEvents) {
                if (!event.args) continue;
                const { name, owner, expires } = event.args;
                const hexTokenId = ethers.namehash(name);
                const tokenId = BigInt(hexTokenId).toString();
                console.log(`Found DomainRegistered: ${name} (Token ID: ${tokenId}) at block ${event.blockNumber}`);
                await updateDatabase(tokenId, { name: name, owner: owner, expiry: expires.toString() }, false);
                processedRegistrationEvents++;
            }

            // Renewals
            const domainRenewedFilter = registrar.filters.DomainRenewed();
            const pastRenewedEvents = await registrar.queryFilter(domainRenewedFilter, fromBlock, toBlock);

            for (const event of pastRenewedEvents) {
                if (!event.args) continue;
                const { name, owner, expires } = event.args;
                const hexTokenId = ethers.namehash(name);
                const tokenId = BigInt(hexTokenId).toString();
                console.log(`Found DomainRenewed: ${name} (Token ID: ${tokenId}) at block ${event.blockNumber}`);
                await updateDatabase(tokenId, { name: name, expiry: expires.toString() }, false);
                processedRenewalEvents++;
            }

            // TextChanged (Metadata)
            const textChangedFilter = resolver.filters.TextChanged();
            const pastTextChangedEvents = await resolver.queryFilter(textChangedFilter, fromBlock, toBlock);

            for (const event of pastTextChangedEvents) {
                if (!event.args) continue;
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
                    console.log(`Found TextChanged for ${key} on token ${tokenId} at block ${event.blockNumber}`);
                    await updateDatabase(tokenId, { [dbKey]: value }, false);
                    processedTextChangedEvents++;
                }
            }
        }

        await getAndSetLastProcessedBlock(db, currentBlock);

        const summary = `Indexing complete. Processed ${processedTransferEvents} transfers, ${processedRegistrationEvents} registrations, ${processedRenewalEvents} renewals, and ${processedTextChangedEvents} metadata changes.`;
        console.log(summary);
        res.status(200).send(summary);

    } catch (error) {
        console.error("Error in indexer function:", error);
        res.status(500).send("Internal Server Error");
    }
};
