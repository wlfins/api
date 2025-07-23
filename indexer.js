require('dotenv').config();
const { ethers } = require("ethers");
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const RPC_URL = process.env.MAINNET_RPC_URL;
const REGISTRAR_ADDR = process.env.REGISTRAR_ADDR;
const RESOLVER_ADDR = process.env.RESOLVER_ADDR;

const REGISTRAR_ABI = [
    "event DomainRegistered(string name, address owner, uint256 expires)",
    "event DomainRenewed(string name, address owner, uint256 expires)"
];

const RESOLVER_ABI = [
    "event TextChanged(bytes32 indexed node, string indexed indexedKey, string key, string value)"
];

const dbPath = path.join(__dirname, 'db.json');

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

    console.log("Attaching event listeners...");

    registrar.on("DomainRegistered", async (name, owner, expires) => {
        try {
            console.log(`[+] New Domain Registered: ${name}`);
            const tokenId = ethers.namehash(name);
            updateDatabase(tokenId, { name, owner, expiry: expires.toString() });
        } catch (error) {
            console.error("Error processing DomainRegistered event:", error);
        }
    });

    registrar.on("DomainRenewed", async (name, owner, expires) => {
        try {
            console.log(`[+] Domain Renewed: ${name}`);
            const tokenId = ethers.namehash(name);
            updateDatabase(tokenId, { expiry: expires.toString() });
        } catch (error) {
            console.error("Error processing DomainRenewed event:", error);
        }
    });

    resolver.on("TextChanged", async (node, indexedKey, key, value) => {
        try {
            console.log(`[+] Text Record Changed for node ${node}`);
            const tokenId = node; // In our system, the node is the tokenId
            const keyMap = {
                "description": "description",
                "avatar": "avatar",
                "x": "xUsername"
            };
            const dbKey = keyMap[key];
            if (dbKey) {
                updateDatabase(tokenId, { [dbKey]: value });
            }
        } catch (error) {
            console.error("Error processing TextChanged event:", error);
        }
    });

    console.log("Listening for events...");
}

// --- Database Helper ---
function updateDatabase(tokenId, newData) {
    let db = {};
    try {
        // Read synchronously to prevent race conditions from multiple events firing at once.
        const data = fs.readFileSync(dbPath, 'utf8');
        db = JSON.parse(data);
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error("Error reading or parsing db.json, starting fresh.", err);
        }
        // If file doesn't exist or is corrupt, we start with an empty object.
        db = {};
    }

    // Merge new data with existing data
    db[tokenId] = { ...(db[tokenId] || {}), ...newData };

    try {
        // Write synchronously to prevent race conditions.
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
        console.log(`Database updated for token ID: ${tokenId}`);
    } catch (err) {
        console.error("Error writing to database:", err);
    }
}

main().catch(error => {
    console.error("Unhandled error in indexer:", error);
    process.exit(1);
});
