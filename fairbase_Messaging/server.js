/************************************
 * Load Environment Variables
 ************************************/
require("dotenv").config();

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
 * Debug ENV (Remove Later)
 ************************************/
console.log("✅ MYSQL_URL:", process.env.MYSQL_URL);

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
const db = mysql.createPool(process.env.MYSQL_URL);

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
 * Check DB Every 5 Seconds
 ************************************/
setInterval(async () => {
  try {
    const [rows] = await db.query(`
      SELECT *
      FROM user_locations
      WHERE safe IS NULL
    `);

    if (rows.length === 0) return;

    for (let row of rows) {
      if (row.fcm_token) {
        await sendNotification(row.fcm_token, row.location_id);

        console.log("✅ Sent to:", row.username || row.name);
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
    const { location_id, safe, comment } = req.body;

    if (!location_id) {
      return res.status(400).json({
        success: false,
        message: "location_id is required",
      });
    }

    await db.query(
      `
      UPDATE user_locations
      SET safe = ?, comment = ?
      WHERE location_id = ?
    `,
      [safe, comment || null, location_id]
    );

    res.json({
      success: true,
      message: "Response saved",
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
 * Health Check Route
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
