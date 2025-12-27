
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const cron = require("node-cron");
const twilio = require("twilio");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Twilio client
const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// Root test route
app.get("/", (req, res) => {
    res.send("MediAlert Backend is Running...");
});


app.post("/api/signup", async (req, res) => {
    const { name, email, password, phone, age, gender, medical_history } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({ message: "Name, email and password are required" });
    }

    let connection;
    try {
        connection = await db.getConnection();

        const [exists] = await connection.query(
            "SELECT user_id FROM Users WHERE email=?",
            [email]
        );

        if (exists.length > 0) {
            return res.status(409).json({ message: "Account already exists" });
        }

        const hash = await bcrypt.hash(password, 10);
        const formattedPhone = phone.startsWith("+91") ? phone : `+91${phone}`;

        const [insert] = await connection.query(
            `INSERT INTO Users (name,email,password_hash,phone,age,gender)
             VALUES (?,?,?,?,?,?)`,
            [name, email, hash, formattedPhone, age, gender]
        );

        const userId = insert.insertId;

        if (medical_history) {
            const today = new Date().toISOString().split("T")[0];
            await connection.query(
                `INSERT INTO IllnessHistory (user_id, illness_name, start_date, notes)
                 VALUES (?,?,?,?)`,
                [userId, medical_history, today, "Initial entry"]
            );
        }

        res.status(201).json({ message: "Signup successful", userId });

    } catch (err) {
        console.error("SIGNUP ERROR:", err);
        res.status(500).json({ message: "Server error" });
    } finally {
        if (connection) connection.release();
    }
});


app.post("/api/login", async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password)
        return res.status(400).json({ message: "Email and password required" });

    let connection;
    try {
        connection = await db.getConnection();
        const [rows] = await connection.query(
            `SELECT user_id,name,email,password_hash FROM Users WHERE email=?`,
            [email]
        );

        if (rows.length === 0)
            return res.status(401).json({ message: "Invalid credentials" });

        const user = rows[0];

        const match = await bcrypt.compare(password, user.password_hash);

        if (!match)
            return res.status(401).json({ message: "Invalid credentials" });

        res.json({
            message: "Login successful",
            user: {
                id: user.user_id,
                name: user.name,
                email: user.email
            }
        });

    } catch (err) {
        console.error("LOGIN ERROR:", err);
        res.status(500).json({ message: "Server error" });
    } finally {
        if (connection) connection.release();
    }
});


app.post("/api/treatments", async (req, res) => {
    const { userId, treatmentName, startDate, endDate, medicines } = req.body;

    if (!userId || !treatmentName || !startDate || !endDate || !medicines)
        return res.status(400).json({ message: "Missing required fields" });

    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const [treat] = await connection.query(
            `INSERT INTO Treatments (user_id,name,start_date,end_date)
             VALUES (?,?,?,?)`,
            [userId, treatmentName, startDate, endDate]
        );

        const treatmentId = treat.insertId;

        for (const med of medicines) {
            await connection.query(
                `INSERT INTO Medicines (treatment_id,name,dosage_qty,dosage_unit,meal_relation,specific_time)
                 VALUES (?,?,?,?,?,?)`,
                [
                    treatmentId,
                    med.name,
                    med.qty,
                    med.unit,
                    med.mealRelation,
                    med.time
                ]
            );
        }

        await connection.commit();

        res.status(201).json({ message: "Treatment added", treatmentId });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error("TREATMENT ERROR:", err);
        res.status(500).json({ message: "Server error" });
    } finally {
        if (connection) connection.release();
    }
});


app.get("/api/dashboard/:userId", async (req, res) => {
    const { userId } = req.params;

    let connection;
    try {
        connection = await db.getConnection();

        const today = new Date().toISOString().split("T")[0];

        const [rows] = await connection.query(
            `SELECT M.medicine_id, M.name AS medicine_name, M.dosage_qty, M.dosage_unit,
                    M.meal_relation, M.specific_time,
                    T.name AS treatment_name,
                    CASE WHEN EXISTS (
                        SELECT 1 FROM MedicationLog L WHERE L.medicine_id=M.medicine_id 
                        AND L.user_id=? AND DATE(L.taken_at)=?
                    ) THEN TRUE ELSE FALSE END AS is_taken_today
             FROM Medicines M
             JOIN Treatments T ON M.treatment_id=T.treatment_id
             WHERE T.user_id=? AND T.start_date<=? AND T.end_date>=?
             ORDER BY M.specific_time`,
            [userId, today, userId, today, today]
        );

        res.json(rows);

    } catch (err) {
        console.error("DASHBOARD ERROR:", err);
        res.status(500).json({ message: "Error fetching dashboard" });
    } finally {
        if (connection) connection.release();
    }
});


app.get("/api/profile/:userId", async (req, res) => {
    const { userId } = req.params;

    let connection;
    try {
        connection = await db.getConnection();

        const [rows] = await connection.query(
            `SELECT user_id AS id, name, email, phone, age, gender 
             FROM Users WHERE user_id=?`,
            [userId]
        );

        if (rows.length === 0)
            return res.status(404).json({ message: "User not found" });

        res.json(rows[0]);

    } catch (err) {
        console.error("PROFILE ERROR:", err);
        res.status(500).json({ message: "Error" });
    } finally {
        if (connection) connection.release();
    }
});


app.get("/api/medical-history/:userId", async (req, res) => {
    const { userId } = req.params;

    let connection;
    try {
        connection = await db.getConnection();

        const [illness] = await connection.query(
            `SELECT * FROM IllnessHistory WHERE user_id=? ORDER BY created_at DESC`,
            [userId]
        );

        const [logs] = await connection.query(
            `SELECT L.*, M.name AS medicine_name 
             FROM MedicationLog L 
             JOIN Medicines M ON L.medicine_id=M.medicine_id
             WHERE L.user_id=? ORDER BY L.taken_at DESC`,
            [userId]
        );

        res.json({ illness_history: illness, medication_log: logs });

    } catch (err) {
        console.error("MEDICAL HISTORY ERROR:", err);
        res.status(500).json({ message: "Error" });
    } finally {
        if (connection) connection.release();
    }
});

app.post("/api/illness-history", async (req, res) => {
    const { userId, illnessName, startDate, endDate, notes } = req.body;

    if (!userId || !illnessName || !startDate)
        return res.status(400).json({ message: "Missing required fields" });

    let connection;
    try {
        connection = await db.getConnection();

        const [result] = await connection.query(
            `INSERT INTO IllnessHistory (user_id, illness_name, start_date, end_date, notes)
             VALUES (?,?,?,?,?)`,
            [userId, illnessName, startDate, endDate || null, notes || null]
        );

        res.json({ message: "Illness added", id: result.insertId });

    } catch (err) {
        console.error("ADD ILLNESS ERROR:", err);
        res.status(500).json({ message: "Error" });
    } finally {
        if (connection) connection.release();
    }
});


app.delete("/api/illness-history/:id", async (req, res) => {
    const { id } = req.params;

    let connection;
    try {
        connection = await db.getConnection();
        await connection.query(`DELETE FROM IllnessHistory WHERE id=?`, [id]);
        res.json({ message: "Entry deleted" });

    } catch (err) {
        console.error("DELETE ILLNESS ERROR:", err);
        res.status(500).json({ message: "Error" });
    } finally {
        if (connection) connection.release();
    }
});


app.post("/api/log", async (req, res) => {
    const { userId, medicineId, note } = req.body;

    if (!userId || !medicineId)
        return res.status(400).json({ message: "Missing fields" });

    let connection;
    try {
        connection = await db.getConnection();

        const time = new Date().toISOString().slice(0, 19).replace("T", " ");

        await connection.query(
            `INSERT INTO MedicationLog (user_id, medicine_id, taken_at, side_effects_note)
             VALUES (?,?,?,?)`,
            [userId, medicineId, time, note || null]
        );

        res.json({ message: "Medication logged" });

    } catch (err) {
        console.error("LOG ERROR:", err);
        res.status(500).json({ message: "Error" });
    } finally {
        if (connection) connection.release();
    }
});


app.post("/api/test-sms", async (req, res) => {
    const { to, message } = req.body;

    try {
        const msg = await twilioClient.messages.create({
            body: message,
            from: process.env.TWILIO_PHONE_NUMBER,
            to
        });

        res.json({
            success: true,
            sid: msg.sid
        });

    } catch (err) {
        console.error("TWILIO ERROR:", err);
        res.status(500).json({ message: err.message });
    }
});


cron.schedule("* * * * *", async () => {
    console.log("⏳ Checking reminders...");

    let connection;
    try {
        connection = await db.getConnection();

        const now = new Date();
        const currentTime = now.toTimeString().slice(0, 5); // HH:MM
        const today = now.toISOString().split("T")[0];

        // 1. Get today's due medicines
        const [meds] = await connection.query(
            `SELECT M.medicine_id, M.name AS medicine_name, M.specific_time,
                    U.user_id, U.phone, U.name AS user_name
             FROM Medicines M
             JOIN Treatments T ON M.treatment_id=T.treatment_id
             JOIN Users U ON T.user_id=U.user_id
             WHERE M.specific_time=? 
             AND T.start_date<=? AND T.end_date>=?`,
            [`${currentTime}:00`, today, today]
        );

        if (meds.length === 0) {
            console.log("No reminders right now.");
            return;
        }

        for (const med of meds) {
            // 2. Check if already sent to avoid duplicates
            const [exists] = await connection.query(
                `SELECT id FROM ReminderLog
                 WHERE user_id=? AND medicine_id=?
                 AND reminder_date=? AND reminder_time=?`,
                [med.user_id, med.medicine_id, today, currentTime]
            );

            if (exists.length > 0) {
                console.log(`Already sent → ${med.medicine_name}`);
                continue;
            }

            // 3. Send SMS
            const text = `⏰ Hello ${med.user_name}, it's time to take your medicine: ${med.medicine_name}`;

            let sent_sid = null;

            try {
                const sms = await twilioClient.messages.create({
                    body: text,
                    from: process.env.TWILIO_PHONE_NUMBER,
                    to: med.phone
                });

                sent_sid = sms.sid;
                console.log("📨 SMS sent →", med.phone);

            } catch (err) {
                console.error("SMS SEND ERROR:", err);
            }

            // 4. Log reminder
            await connection.query(
                `INSERT INTO ReminderLog 
                 (user_id, medicine_id, reminder_date, reminder_time, sent_at, twilio_sid, created_at)
                 VALUES (?,?,?,?,NOW(),?,NOW())`,
                [
                    med.user_id,
                    med.medicine_id,
                    today,
                    currentTime,
                    sent_sid
                ]
            );
        }

    } catch (err) {
        console.error("CRON ERROR:", err);
    } finally {
        if (connection) connection.release();
    }
});


app.listen(PORT, () => {
    console.log(`MediAlert Backend running at http://localhost:${PORT}`);
});
