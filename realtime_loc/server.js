const express = require('express');
const mysql = require('mysql2/promise');
const app = express();
app.use(express.json());

// MySQL connection pool using Railway environment variables
const pool = mysql.createPool({
    host: process.env.MYSQLHOST,
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE,
    port: process.env.MYSQLPORT,
    waitForConnections: true,
});

// Helper function to get current IST as MySQL DATETIME string (YYYY-MM-DD HH:MM:SS)
function getISTDateTime() {
    const now = new Date();
    // IST is UTC+5:30
    const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    const year = istTime.getUTCFullYear();
    const month = String(istTime.getUTCMonth() + 1).padStart(2, '0');
    const day = String(istTime.getUTCDate()).padStart(2, '0');
    const hours = String(istTime.getUTCHours()).padStart(2, '0');
    const minutes = String(istTime.getUTCMinutes()).padStart(2, '0');
    const seconds = String(istTime.getUTCSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// ----------------------------------------------------------------------
// Table creation (runs once at startup)
// ----------------------------------------------------------------------
async function createTables() {
    try {
        // Users table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(255) NOT NULL,
                device_id VARCHAR(255) UNIQUE NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Users table ready');

        // User locations table – one row per user (latest location)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_locations (
                user_id INT PRIMARY KEY,
                username VARCHAR(255) NOT NULL,
                latitude DOUBLE NULL,
                longitude DOUBLE NULL,
                timestamp BIGINT NOT NULL,
                fcm_token VARCHAR(255) NULL,
                updated_at DATETIME NOT NULL
            )
        `);
        console.log('✅ User locations table ready');

        // Ensure fcm_token column exists (for older tables)
        try {
            await pool.query(`ALTER TABLE user_locations ADD COLUMN fcm_token VARCHAR(255) NULL`);
            console.log('✅ Added fcm_token column to user_locations table');
        } catch (err) {
            if (err.code === 'ER_DUP_FIELDNAME') {
                console.log('ℹ️ fcm_token column already exists');
            } else {
                console.error('⚠️ Error adding fcm_token column:', err.message);
            }
        }
    } catch (err) {
        console.error('❌ Error during table creation:', err);
    }
}

// Run table creation (non‑blocking)
createTables();

// ----------------------------------------------------------------------
// Helper to ensure the users table exists (used in registration endpoint)
// ----------------------------------------------------------------------
async function ensureUsersTable() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(255) NOT NULL,
                device_id VARCHAR(255) UNIQUE NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
    } catch (err) {
        console.error('❌ Failed to create users table on demand:', err);
        throw err;
    }
}

// Helper to ensure the user_locations table exists (used in location endpoint)
async function ensureUserLocationsTable() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_locations (
                user_id INT PRIMARY KEY,
                username VARCHAR(255) NOT NULL,
                latitude DOUBLE NULL,
                longitude DOUBLE NULL,
                timestamp BIGINT NOT NULL,
                fcm_token VARCHAR(255) NULL,
                updated_at DATETIME NOT NULL
            )
        `);
        // Also ensure fcm_token column (for very old tables)
        try {
            await pool.query(`ALTER TABLE user_locations ADD COLUMN fcm_token VARCHAR(255) NULL`);
        } catch (err) {
            if (err.code !== 'ER_DUP_FIELDNAME') throw err;
        }
    } catch (err) {
        console.error('❌ Failed to create user_locations table on demand:', err);
        throw err;
    }
}

// ----------------------------------------------------------------------
// Registration endpoint (with on‑demand table creation)
// ----------------------------------------------------------------------
app.post('/api/register', async (req, res) => {
    const { username, deviceId } = req.body;
    if (!username || !deviceId) {
        return res.status(400).json({ error: 'Missing fields' });
    }

    try {
        const [result] = await pool.query(
            'INSERT INTO users (username, device_id) VALUES (?, ?)',
            [username, deviceId]
        );
        res.json({ userId: result.insertId });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            // Device already registered – return existing user ID
            const [rows] = await pool.query(
                'SELECT id FROM users WHERE device_id = ?',
                [deviceId]
            );
            if (rows.length > 0) {
                return res.json({ userId: rows[0].id });
            }
        } else if (err.code === 'ER_NO_SUCH_TABLE') {
            // Table missing – create it and retry once
            console.log('⚠️ users table missing – creating it now...');
            try {
                await ensureUsersTable();
                const [result] = await pool.query(
                    'INSERT INTO users (username, device_id) VALUES (?, ?)',
                    [username, deviceId]
                );
                return res.json({ userId: result.insertId });
            } catch (retryErr) {
                console.error('❌ Registration failed after creating table:', retryErr);
                return res.status(500).json({ error: retryErr.message });
            }
        }
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------------------------------------------------
// Location update endpoint (with on‑demand table creation)
// ----------------------------------------------------------------------
app.post('/api/location', async (req, res) => {
    const { userId, username, latitude, longitude, timestamp, fcmToken } = req.body;

    if (!userId || !username || latitude === undefined || longitude === undefined || !timestamp) {
        return res.status(400).json({ error: 'Missing fields' });
    }

    const istNow = getISTDateTime();

    try {
        await performUpsert(userId, username, latitude, longitude, timestamp, fcmToken, istNow);
        res.json({ success: true });
    } catch (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') {
            console.log('⚠️ user_locations table missing – creating it now...');
            try {
                await ensureUserLocationsTable();
                await performUpsert(userId, username, latitude, longitude, timestamp, fcmToken, istNow);
                res.json({ success: true });
            } catch (retryErr) {
                console.error('❌ Location update failed after creating table:', retryErr);
                res.status(500).json({ error: retryErr.message });
            }
        } else {
            console.error(err);
            res.status(500).json({ error: err.message });
        }
    }
});

// Separated upsert logic for clarity
async function performUpsert(userId, username, latitude, longitude, timestamp, fcmToken, istNow) {
    await pool.query(
        `INSERT INTO user_locations (user_id, username, latitude, longitude, timestamp, fcm_token, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
         username = VALUES(username),
         latitude = IF(VALUES(latitude) IS NOT NULL, VALUES(latitude), latitude),
         longitude = IF(VALUES(longitude) IS NOT NULL, VALUES(longitude), longitude),
         timestamp = VALUES(timestamp),
         fcm_token = IF(VALUES(fcm_token) IS NOT NULL, VALUES(fcm_token), fcm_token),
         updated_at = VALUES(updated_at)`,
        [userId, username, latitude, longitude, timestamp, fcmToken || null, istNow]
    );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
