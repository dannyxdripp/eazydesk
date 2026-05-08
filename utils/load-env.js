const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function loadEnv() {
    const candidates = [
        path.resolve(__dirname, '..', '..', '.env'),
        path.resolve(__dirname, '..', '.env')
    ];

    const loaded = [];

    for (const envPath of candidates) {
        if (!fs.existsSync(envPath)) continue;
        dotenv.config({ path: envPath, override: false });
        loaded.push(envPath);
    }

    return loaded;
}

module.exports = { loadEnv };
