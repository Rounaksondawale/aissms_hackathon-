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

// Create tables if they don't exist
(async () => {
    try {
        // Users table (as before)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS temp (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(255) NOT NULL,
                device_id VARCHAR(255) UNIQUE NOT NULL,
                time_stamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // User locations table – one row per user (latest location)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_locations (
                user_id INT PRIMARY KEY,
                username VARCHAR(255) NOT NULL,
                latitude DOUBLE NULL,
                longitude DOUBLE NULL,
                timestamp BIGINT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);

        console.log('Tables ready');
    } catch (err) {
        console.error('Error creating tables', err);
    }
})();

// Registration endpoint (unchanged)
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

// Location update endpoint – UPSERT (insert or update)
app.post('/api/location', async (req, res) => {
    const { userId, username, latitude, longitude, timestamp } = req.body;
    
    if (!userId || !username || latitude === undefined || longitude === undefined || !timestamp) {
        return res.status(400).json({ error: 'Missing fields' });
    }

    try {
        await pool.query(
            `INSERT INTO user_locations (user_id, username, latitude, longitude, timestamp)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
             username = VALUES(username),
             latitude = VALUES(latitude),
             longitude = VALUES(longitude),
             timestamp = VALUES(timestamp)`,
            [userId, username, latitude, longitude, timestamp]
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
