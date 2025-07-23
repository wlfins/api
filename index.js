const express = require('express');
const cors = require('cors');
const { getDB } = require('./mongo');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());

// Endpoint to get metadata for a specific token ID
app.get('/metadata/:tokenId', async (req, res) => {
    const { tokenId } = req.params;

    try {
        const db = await getDB();
        const metadata = await db.collection('domains').findOne({ tokenId: parseInt(tokenId) });

        if (!metadata) {
            return res.status(404).json({ error: "Metadata not found for this token" });
        }

        const attributes = [
            {
                trait_type: "Expires",
                display_type: "date",
                value: metadata.expiry
            }
        ];

        if (metadata.xUsername) {
            attributes.push({
                trait_type: "X Username",
                value: metadata.xUsername
            });
        }

        res.json({
            name: metadata.name,
            description: metadata.description || "A domain on the WLFI Name Service.",
            image: metadata.avatar || `https://your-api-url.com/default-logo.png`, // Replace with a real URL later
            external_url: `https://your-wlfi-ns-website.com/domains/${metadata.name}`,
            attributes: attributes
        });
    } catch (err) {
        console.error("Error fetching from database:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.listen(port, () => {
    console.log(`WLFI NS Metadata API listening on port ${port}`);
});
