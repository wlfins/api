const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());

const dbPath = path.join(__dirname, 'db.json');

// Endpoint to get metadata for a specific token ID
app.get('/metadata/:tokenId', (req, res) => {
    const { tokenId } = req.params;

    fs.readFile(dbPath, 'utf8', (err, data) => {
        if (err) {
            console.error("Error reading database:", err);
            return res.status(500).json({ error: "Internal server error" });
        }

        const db = JSON.parse(data);
        const metadata = db[tokenId];

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
    });
});

app.listen(port, () => {
    console.log(`WLFI NS Metadata API listening on port ${port}`);
});
