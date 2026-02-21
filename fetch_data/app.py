from flask import Flask, jsonify
from flask_cors import CORS
from sqlalchemy import create_engine, text
import os

app = Flask(__name__)
CORS(app)   # Allow Android to connect

# Railway gives DATABASE_URL automatically
DATABASE_URL = os.getenv("mysql+pymysql://root:xcntlInETcnxqDoJYzLaHPSLHeKQzVrQ@gondola.proxy.rlwy.net:49664/railway")

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True
)

# Test Route
@app.route("/")
def home():
    return "✅ Server is running!"

# Example: Fetch Data
@app.route("/users", methods=["GET"])
def get_users():

    try:
        with engine.connect() as conn:

            result = conn.execute(
                text("SELECT * FROM user_locations")
            )

            data = []

            for row in result:
                data.append(dict(row._mapping))

        return jsonify({
            "status": "success",
            "data": data
        })

    except Exception as e:
        return jsonify({
            "status": "error",
            "message": str(e)
        })

# Run
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
