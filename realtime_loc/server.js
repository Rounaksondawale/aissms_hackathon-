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

// Create tables if they don't exist and add missing columns
(async () => {
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
        console.log('Users table ready');

        // User locations table – one row per user (latest location)
        // Includes fcm_token column to store push notification token
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
        console.log('User locations table ready');

        // In case the table existed before we added the fcm_token column,
        // attempt to add it now (ignores error if already present).
        try {
            await pool.query(`ALTER TABLE user_locations ADD COLUMN fcm_token VARCHAR(255) NULL`);
            console.log('Added fcm_token column to user_locations table');
        } catch (err) {
            // Column already exists (error code ER_DUP_FIELDNAME = 1060)
            if (err.code !== 'ER_DUP_FIELDNAME') {
                console.error('Error adding fcm_token column', err);
            }
        }
    } catch (err) {
        console.error('Error creating tables', err);
    }
})();

// Registration endpoint
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
            const [rows] = await pool.query(
                'SELECT id FROM users WHERE device_id = ?',
                [deviceId]
            );
            if (rows.length > 0) {
                return res.json({ userId: rows[0].id });
            }
        }
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Location update endpoint – UPSERT (insert or update) with IST timestamp and optional fcmToken
// This preserves existing latitude/longitude when null is sent (token-only updates).
app.post('/api/location', async (req, res) => {
    const { userId, username, latitude, longitude, timestamp, fcmToken } = req.body;
    
    if (!userId || !username || latitude === undefined || longitude === undefined || !timestamp) {
        return res.status(400).json({ error: 'Missing fields' });
    }

    const istNow = getISTDateTime();

    try {
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
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
