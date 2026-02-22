const express = require("express");
const mysql = require("mysql2/promise");
const admin = require("firebase-admin");
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(bodyParser.json());

/* ---------- Firebase Setup ---------- */

const serviceAccount = require("./firebase-key.json"); // Download from Firebase

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

/* ---------- MySQL Connection ---------- */

const db = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
});

/* ---------- Send FCM ---------- */

async function sendNotification(token, id) {
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
}

/* ---------- Check New Records Every 5s ---------- */

setInterval(async () => {
  try {
    const [rows] = await db.query(`
      SELECT * FROM user_locations
      WHERE safe IS NULL
    `);

    for (let row of rows) {
      if (row.fcm_token) {
        await sendNotification(row.fcm_token, row.location_id);

        console.log("Sent to:", row.name);
      }
    }
  } catch (err) {
    console.error(err);
  }
}, 5000); // every 5 sec

/* ---------- Receive User Response ---------- */

app.post("/response", async (req, res) => {
  const { location_id, safe, comment } = req.body;

  await db.query(
    `
    UPDATE user_locations
    SET safe = ?, comment = ?
    WHERE location_id = ?
  `,
    [safe, comment, location_id]
  );

  res.json({ success: true });
});

/* ---------- Start Server ---------- */

app.listen(8080, () => {
  console.log("Server running on 8080");
});
