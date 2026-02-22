/************************************
 * Imports
 ************************************/
const express = require("express");
const mysql = require("mysql2/promise");
const admin = require("firebase-admin");
const bodyParser = require("body-parser");
const cors = require("cors");

/************************************
 * App Setup
 ************************************/
const app = express();

app.use(cors());
app.use(bodyParser.json());

/************************************
 * Debug ENV
 ************************************/
console.log("MYSQL_PUBLIC_URL =", process.env.MYSQL_PUBLIC_URL);

/************************************
 * Firebase Setup
 ************************************/
const serviceAccount = require("./firebase-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

/************************************
 * MySQL Connection (Railway)
 ************************************/
const db = mysql.createPool({
  uri: process.env.MYSQL_PUBLIC_URL,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: {
    rejectUnauthorized: false,
  },
});

/************************************
 * Test DB Connection
 ************************************/
(async () => {
  try {
    const conn = await db.getConnection();
    console.log("✅ MySQL Connected Successfully");
    conn.release();
  } catch (err) {
    console.error("❌ MySQL Connection Failed:", err);
  }
})();

/************************************
 * Send FCM Notification
 ************************************/
async function sendNotification(token, id) {
  try {
    const message = {
      token: token,

      notification: {
        title: "Safety Alert 🚨",
        body: "Are you safe? Please respond.",
      },

      data: {
        record_id: id.toString(),
      },
    };

    await admin.messaging().send(message);

    console.log("📩 Notification sent to:", token);
  } catch (err) {
    console.error("❌ FCM Error:", err);
  }
}

/************************************
 * Check circle_selection Every 5s
 ************************************/
setInterval(async () => {
  try {
    const [rows] = await db.query(`
      SELECT *
      FROM circle_selection
      WHERE safe IS NULL
    `);

    if (rows.length === 0) return;

    for (const row of rows) {
      if (row.fcm_token) {
        await sendNotification(row.fcm_token, row.id);

        console.log("✅ Alert sent to:", row.username || row.name);
      }
    }
  } catch (err) {
    console.error("❌ DB Query Error:", err);
  }
}, 5000);

/************************************
 * Receive User Response
 ************************************/
app.post("/response", async (req, res) => {
  try {
    const { id, safe, comment } = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "id is required",
      });
    }

    await db.query(
      `
      UPDATE circle_selection
      SET safe = ?, comment = ?
      WHERE id = ?
    `,
      [safe, comment || null, id]
    );

    res.json({
      success: true,
      message: "Response saved successfully",
    });
  } catch (err) {
    console.error("❌ Update Error:", err);

    res.status(500).json({
      success: false,
      error: "Server error",
    });
  }
});

/************************************
 * Health Check
 ************************************/
app.get("/", (req, res) => {
  res.send("🚀 SOS Rescue Backend Running");
});

/************************************
 * Start Server
 ************************************/
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
