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

function getISTDateTime() {
    const now = new Date();
    const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    return ist.toISOString().slice(0, 19).replace('T', ' ');
}

async function ensureTables() {

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(255) NOT NULL,
            device_id VARCHAR(255) UNIQUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_locations (
            user_id INT PRIMARY KEY,
            username VARCHAR(255),
            latitude DECIMAL(10,8),
            longitude DECIMAL(11,8),
            timestamp BIGINT,
            fcm_token VARCHAR(255),
            updated_at DATETIME
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS sos (
            id INT AUTO_INCREMENT PRIMARY KEY,
            uuid CHAR(36) UNIQUE DEFAULT (UUID()),
            user_id INT NOT NULL,
            username VARCHAR(255),
            rescuer_id INT,
            initial_latitude DECIMAL(10,8),
            initial_longitude DECIMAL(11,8),
            current_latitude DECIMAL(10,8),
            current_longitude DECIMAL(11,8),
            timestamp BIGINT,
            last_updated DATETIME,
            status ENUM('active','resolved') DEFAULT 'active',
            INDEX(user_id),
            INDEX(rescuer_id)
        )
    `);

    console.log("✅ Tables ready");
}

ensureTables();


// ---------------- REGISTER ----------------
app.post('/api/register', async (req, res) => {
    const { username, deviceId } = req.body;
    if (!username || !deviceId)
        return res.status(400).json({ error: 'Missing fields' });

    try {
        const [result] = await pool.query(
            'INSERT INTO users (username, device_id) VALUES (?, ?)',
            [username, deviceId]
        );
        res.json({ userId: result.insertId });

    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            const [rows] = await pool.query(
                'SELECT id FROM users WHERE device_id=?',
                [deviceId]
            );
            return res.json({ userId: rows[0].id });
        }
        res.status(500).json({ error: err.message });
    }
});


// ---------------- LOCATION ----------------
app.post('/api/location', async (req, res) => {

    const { userId, username, latitude, longitude, timestamp, fcmToken } = req.body;

    if (!userId || !username || !timestamp)
        return res.status(400).json({ error: 'Missing fields' });

    const now = getISTDateTime();

    try {
        await pool.query(
            `INSERT INTO user_locations (user_id, username, latitude, longitude, timestamp, fcm_token, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
             username=VALUES(username),
             latitude=IFNULL(VALUES(latitude), latitude),
             longitude=IFNULL(VALUES(longitude), longitude),
             timestamp=VALUES(timestamp),
             fcm_token=IFNULL(VALUES(fcm_token), fcm_token),
             updated_at=VALUES(updated_at)`,
            [userId, username, latitude, longitude, timestamp, fcmToken || null, now]
        );

        res.json({ success: true });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ---------------- START SOS ----------------
app.post('/api/sos', async (req, res) => {

    const { userId, username, rescuerId, latitude, longitude, timestamp } = req.body;

    if (!userId || !username || !rescuerId)
        return res.status(400).json({ error: 'Missing fields' });

    const now = getISTDateTime();

    try {

        const [result] = await pool.query(
            `INSERT INTO sos 
            (user_id, username, rescuer_id, initial_latitude, initial_longitude, current_latitude, current_longitude, timestamp, last_updated, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
            [userId, username, rescuerId, latitude, longitude, latitude, longitude, timestamp, now]
        );

        const [rows] = await pool.query(
            'SELECT uuid FROM sos WHERE id=?',
            [result.insertId]
        );

        res.json({ success: true, uuid: rows[0].uuid });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ---------------- UPDATE SOS ----------------
app.put('/api/sos/:uuid', async (req, res) => {

    const { uuid } = req.params;
    const { latitude, longitude, timestamp } = req.body;

    const now = getISTDateTime();

    try {
        const [result] = await pool.query(
            `UPDATE sos SET current_latitude=?, current_longitude=?, last_updated=?, timestamp=?
             WHERE uuid=? AND status='active'`,
            [latitude, longitude, now, timestamp, uuid]
        );

        if (result.affectedRows === 0)
            return res.status(404).json({ error: 'SOS not found' });

        res.json({ success: true });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ---------------- RESOLVE SOS ----------------
app.put('/api/sos/:uuid/resolve', async (req, res) => {

    await pool.query(
        `UPDATE sos SET status='resolved', last_updated=? WHERE uuid=?`,
        [getISTDateTime(), req.params.uuid]
    );

    res.json({ success: true });
});


// ---------------- ACTIVE SOS ----------------
app.get('/api/sos/active', async (req, res) => {

    const [rows] = await pool.query(
        'SELECT * FROM sos WHERE status="active" ORDER BY timestamp DESC'
    );

    res.json(rows);
});


// ---------------- AUTO CLEANUP ----------------
setInterval(async () => {
    await pool.query(`
        UPDATE sos SET status='resolved'
        WHERE status='active'
        AND last_updated < NOW() - INTERVAL 2 MINUTE
    `);
    console.log("🧹 SOS cleanup done");
}, 60000);


app.listen(process.env.PORT || 3000, () =>
    console.log("🚀 Server running")
);
