const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// MySQL connection config from Railway env vars
const dbConfig = {
    host: process.env.MYSQLHOST,
    port: process.env.MYSQLPORT,
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE,
};

// Test route (optional)
app.get('/', (req, res) => {
    res.send('API is running');
});

// ✅ Your locations endpoint
app.get('/api/locations', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        // 🔁 Make sure 'user_locations' is your actual table name
        const [rows] = await connection.execute('SELECT * FROM user_locations'); // Fixed missing quote
        await connection.end();
        res.json(rows);
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
