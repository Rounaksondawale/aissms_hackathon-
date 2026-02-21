const express = require('express');
const mysql = require('mysql2/promise'); // use promise version
const cors = require('cors');
const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Database configuration from Railway environment variables
const dbConfig = {
    host: process.env.MYSQLHOST,
    port: process.env.MYSQLPORT,
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE,
};

// Test connection and ensure table exists (optional)
async function initialize() {
    try {
        const connection = await mysql.createConnection(dbConfig);
        console.log('Connected to MySQL');

        // Create table if not exists (adjust table name and columns as needed)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS user_locations (
                user_id INT PRIMARY KEY,
                username VARCHAR(255),
                latitude DECIMAL(10,8),
                longitude DECIMAL(11,8),
                timestamp BIGINT,
                updated_at DATETIME
            )
        `);
        console.log('Table checked/created');
        await connection.end();
    } catch (err) {
        console.error('DB init error:', err);
    }
}
initialize();

// API endpoint to get all locations
app.get('/api/locations', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        // Replace 'your_table_name' with your actual table name
        const [rows] = await connection.execute('SELECT user_id, username, latitude, longitude, timestamp, updated_at FROM user_locations');
        await connection.end();
        res.json(rows);
    } catch (err) {
        console.error('Query error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.listen(port, () => {
    console.log(`API running on port ${port}`);
});
