const express = require('express');
const mysql = require('mysql2/promise');
const app = express();
app.use(express.json());

const pool = mysql.createPool({
    host: process.env.MYSQLHOST,
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE,
    port: process.env.MYSQLPORT,
    waitForConnections: true,
});

// Helper to get current time in IST for MySQL DATETIME
function getISTDateTime() {
    const now = new Date();
    const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    const year = istTime.getUTCFullYear();
    const month = String(istTime.getUTCMonth() + 1).padStart(2, '0');
    const day = String(istTime.getUTCDate()).padStart(2, '0');
    const hours = String(istTime.getUTCHours()).padStart(2, '0');
    const minutes = String(istTime.getUTCMinutes()).padStart(2, '0');
    const seconds = String(istTime.getUTCSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// Ensure the SOS table exists
async function ensureSosTable() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sos (
                id INT AUTO_INCREMENT PRIMARY KEY,
                uuid CHAR(36) NOT NULL UNIQUE DEFAULT (UUID()),
                user_id INT NOT NULL,
                username VARCHAR(255) NOT NULL,
                rescuer_id INT NOT NULL,
                initial_latitude DECIMAL(10,8) NOT NULL,
                initial_longitude DECIMAL(11,8) NOT NULL,
                current_latitude DECIMAL(10,8),
                current_longitude DECIMAL(11,8),
                timestamp BIGINT NOT NULL,
                last_updated DATETIME,
                status ENUM('active', 'resolved') DEFAULT 'active',
                INDEX (user_id),
                INDEX (rescuer_id)
            );
        `);
        console.log('✅ SOS table ready');
    } catch (err) {
        console.error('Error creating SOS table:', err);
    }
}
// Call once at startup (optional, but good practice)
ensureSosTable();

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
        } else if (err.code === 'ER_NO_SUCH_TABLE') {
            // Table missing – create it and retry (simplified)
            await createUsersTable();
            return this.post(req, res); // Retry
        }
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Location + FCM token endpoint
app.post('/api/location', async (req, res) => {
    console.log('📍 /api/location body:', req.body);

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
        if (err.code === 'ER_NO_SUCH_TABLE') {
            // Create table and retry
            await createUserLocationsTable();
            // Retry this request
            return this.post(req, res);
        }
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// -------------------- SOS Endpoints --------------------

// POST /api/sos - Create a new SOS record (initiated by rescuer)
app.post('/api/sos', async (req, res) => {
    console.log('🚨 /api/sos body:', req.body);

    const { userId, username, rescuerId, latitude, longitude, timestamp } = req.body;
    if (!userId || !username || !rescuerId || latitude === undefined || longitude === undefined || !timestamp) {
        return res.status(400).json({ error: 'Missing fields' });
    }

    const istNow = getISTDateTime();

    try {
        // Ensure table exists (optional – we already did at startup)
        await ensureSosTable();

        const [result] = await pool.query(
            `INSERT INTO sos 
             (user_id, username, rescuer_id, initial_latitude, initial_longitude, current_latitude, current_longitude, timestamp, last_updated, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
            [userId, username, rescuerId, latitude, longitude, latitude, longitude, timestamp, istNow]
        );

        // Retrieve the generated UUID (since we used DEFAULT (UUID()), we need to fetch it)
        const [rows] = await pool.query('SELECT uuid FROM sos WHERE id = ?', [result.insertId]);
        const uuid = rows[0]?.uuid;

        res.json({ success: true, uuid });
    } catch (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') {
            // Table missing – create it and retry
            await ensureSosTable();
            return this.post(req, res);
        }
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/sos/:uuid - Update an SOS record with new location
app.put('/api/sos/:uuid', async (req, res) => {
    const { uuid } = req.params;
    const { latitude, longitude, timestamp } = req.body;

    if (!uuid || latitude === undefined || longitude === undefined || !timestamp) {
        return res.status(400).json({ error: 'Missing fields' });
    }

    const istNow = getISTDateTime();

    try {
        const [result] = await pool.query(
            `UPDATE sos 
             SET current_latitude = ?, current_longitude = ?, last_updated = ?, timestamp = ?
             WHERE uuid = ? AND status = 'active'`,
            [latitude, longitude, istNow, timestamp, uuid]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'SOS record not found or already resolved' });
        }

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Optional: GET /api/sos/active - fetch all active SOS records (for admin/debug)
app.get('/api/sos/active', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM sos WHERE status = "active" ORDER BY timestamp DESC');
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Helper to create users table if missing (simplified)
async function createUsersTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(255) NOT NULL,
            device_id VARCHAR(255) NOT NULL UNIQUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
}

// Helper to create user_locations table if missing
async function createUserLocationsTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_locations (
            user_id INT PRIMARY KEY,
            username VARCHAR(255) NOT NULL,
            latitude DECIMAL(10,8),
            longitude DECIMAL(11,8),
            timestamp BIGINT,
            fcm_token VARCHAR(255),
            updated_at DATETIME
        );
    `);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
