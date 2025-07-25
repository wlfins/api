require('dotenv').config();

const express = require('express');
const cors = require('cors');
const sharp = require('sharp');
const fetch = require('node-fetch');
const TextToSVG = require('text-to-svg');
const path = require('path');
const { connectToServer, getDB } = require('./mongo');

const app = express();
const port = process.env.PORT || 3001;

const textToSVG = TextToSVG.loadSync();

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
        const fontSize = Math.max(30, 90 - domainName.length * 3);

        const attributes = {fill: '#FFD700'};
        const options = {x: 250, y: 450, fontSize: fontSize, anchor: 'center middle', attributes: attributes};

        const path = textToSVG.getD(domainName, options);

        const svg = `
            <svg width="500" height="500" viewBox="0 0 500 500" xmlns="http://www.w3.org/2000/svg">
                <rect width="100%" height="100%" fill="#1A1A1A" />
                <path fill="#FFD700" d="${path}"/>
            </svg>
        `;

        res.setHeader('Content-Type', 'image/svg+xml');
        res.send(svg);
    } catch (err) {
        console.error("Error generating SVG:", err);
        res.status(500).send('Internal Server Error');
    }
});

// --- Composite Image Generation ---
app.get('/composite-image/:tokenId', async (req, res) => {
    const { tokenId } = req.params;
    console.log(`[COMPOSITE] Received request for tokenId: ${tokenId}`);

    try {
        const db = getDB();
        const metadata = await db.collection('domains').findOne({ tokenId: tokenId });

        if (!metadata || !metadata.name) {
            console.log(`[COMPOSITE] Metadata not found for tokenId: ${tokenId}`);
            return res.status(404).send('Not Found');
        }
        console.log(`[COMPOSITE] Found metadata:`, metadata);

        // 1. Fetch the base avatar image
        let baseImageBuffer;
        if (metadata.avatar) {
            console.log(`[COMPOSITE] Fetching avatar from: ${metadata.avatar}`);
            const response = await fetch(metadata.avatar);
            if (!response.ok) {
                console.error(`[COMPOSITE] Failed to fetch avatar image: ${response.statusText}`);
                throw new Error(`Failed to fetch avatar image: ${response.statusText}`);
            }
            baseImageBuffer = await response.buffer();
            console.log(`[COMPOSITE] Successfully fetched avatar image.`);
        } else {
            console.log(`[COMPOSITE] No avatar found, using fallback background.`);
            // Fallback to a plain background if no avatar is set
            baseImageBuffer = await sharp({
                create: {
                    width: 500,
                    height: 500,
                    channels: 4,
                    background: { r: 26, g: 26, b: 26, alpha: 1 }
                }
            }).png().toBuffer();
        }

        // 2. Generate the SVG overlay
        const domainName = metadata.name + ".wlfi";
        const fontSize = Math.max(30, 90 - domainName.length * 3);

        const attributes = {fill: '#FFD700'};
        const options = {x: 250, y: 450, fontSize: fontSize, anchor: 'center middle', attributes: attributes};

        const path = textToSVG.getD(domainName, options);

        const svgOverlay = `
            <svg width="500" height="500" viewBox="0 0 500 500" xmlns="http://www.w3.org/2000/svg">
                <path fill="#FFD700" d="${path}"/>
            </svg>
        `;
        const svgBuffer = Buffer.from(svgOverlay);
        console.log(`[COMPOSITE] Generated SVG overlay for domain: ${domainName}`);

        // 3. Composite the images
        console.log(`[COMPOSITE] Starting image composition...`);
        const compositeImage = await sharp(baseImageBuffer)
            .resize(500, 500)
            .composite([{ input: svgBuffer }])
            .png()
            .toBuffer();
        console.log(`[COMPOSITE] Image composition successful.`);

        // 4. Send the final image
        res.setHeader('Content-Type', 'image/png');
        res.send(compositeImage);

    } catch (err) {
        console.error("Error generating composite image:", err);
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

        // Conditionally set the image URL
        const imageUrl = metadata.avatar 
            ? `${API_URL}/composite-image/${tokenId}` 
            : `${API_URL}/image/${tokenId}`;

        res.json({
            name: metadata.name + '.wlfi',
            description: metadata.description || "A domain on the WLFI Name Service.",
            image: imageUrl,
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
