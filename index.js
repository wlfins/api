require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { connectToServer, getDB } = require('./mongo');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());

// --- Dynamic SVG Image Generation ---
app.get('/image/:tokenId', async (req, res) => {
    const { tokenId } = req.params;
    try {
        const db = getDB();
        const metadata = await db.collection('domains').findOne({ tokenId: tokenId });

        if (!metadata || !metadata.name) {
            return res.status(404).send('Not Found');
        }

        const domainName = metadata.name + ".wlfi";
        const fontSize = Math.max(20, 70 - domainName.length * 2.5);

        const svg = `
            <svg width="500" height="500" viewBox="0 0 500 500" xmlns="http://www.w3.org/2000/svg">
                <rect width="100%" height="100%" fill="#1A1A1A" />
                <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#E6C278" font-size="${fontSize}px" font-family="Arial, sans-serif">
                    ${domainName}
                </text>
            </svg>
        `;

        res.setHeader('Content-Type', 'image/svg+xml');
        res.send(svg);
    } catch (err) {
        console.error("Error generating SVG:", err);
        res.status(500).send('Internal Server Error');
    }
});

// --- Metadata Endpoint ---
app.get('/metadata/:tokenId', async (req, res) => {
    const { tokenId } = req.params;

    try {
        const db = getDB();
        const metadata = await db.collection('domains').findOne({ tokenId: tokenId });

        if (!metadata || !metadata.name) {
            return res.status(404).json({ error: "Metadata not found or is incomplete for this token" });
        }

        const attributes = [
            {
                trait_type: "Expires",
                display_type: "date",
                value: parseInt(metadata.expiry, 10)
            },
            {
                trait_type: "Length",
                display_type: "number",
                value: metadata.name.length
            }
        ];

        const socialFields = {
            xUsername: "X (Twitter)",
            github: "GitHub",
            telegram: "Telegram",
            discord: "Discord"
        };

        for (const [dbKey, traitType] of Object.entries(socialFields)) {
            if (metadata[dbKey]) {
                attributes.push({
                    trait_type: traitType,
                    value: metadata[dbKey]
                });
            }
        }

        if (metadata.website) {
            attributes.push({
                trait_type: "Website",
                value: metadata.website
            });
        }

        // The API_URL should be your Vercel deployment URL
        const API_URL = process.env.API_URL || `http://localhost:${port}`;

        res.json({
            name: metadata.name + '.wlfi',
            description: metadata.description || "A domain on the WLFI Name Service.",
            image: metadata.avatar || `${API_URL}/image/${tokenId}`,
            external_url: `https://www.wlfins.domains/`,
            background_color: "1A1A1A",
            attributes: attributes
        });
    } catch (err) {
        console.error("Error fetching from database:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

connectToServer().then(() => {
    app.listen(port, () => {
        console.log(`WLFI NS Metadata API listening on port ${port}`);
    });
});