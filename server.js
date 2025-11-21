// backend/index.js
require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());


const cors = require("cors");

app.use(cors({
  origin: [
    "https://tinylink-frontend-sable.vercel.app",
    
  ],
  methods: ["GET", "POST", "DELETE"],
  allowedHeaders: ["Content-Type"]
}));




const pool = mysql.createPool({
  host: process.env.DATABASE_HOST,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  port: process.env.DATABASE_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  ssl: {
    rejectUnauthorized: false
  }
});



// Health
app.get('/healthz', (req, res) => {
  res.json({ ok: true, version: "1.0", uptime_seconds: process.uptime() });
});

// Create link
app.post('/api/links', async (req, res) => {
  const { target_url, code } = req.body || {};
  try {
    if (!target_url) return res.status(400).json({ error: 'target_url required' });
    // URL validation
    try { new URL(target_url); } catch(e){ return res.status(400).json({ error: 'Invalid URL' }); }

    let shortCode = code;
    if (shortCode) {
      if (!/^[A-Za-z0-9]{6,8}$/.test(shortCode)) return res.status(400).json({ error: 'Code must match [A-Za-z0-9]{6,8}' });
    } else {
      // generate 6 char code (retry on conflict up to N times)
      const gen = () => Math.random().toString(36).slice(2, 8).replace(/[^A-Za-z0-9]/g,'').slice(0,6);
      let tries = 0;
      do { shortCode = gen(); tries++; } while (tries < 5 && await codeExists(pool, shortCode));
      if (await codeExists(pool, shortCode)) return res.status(500).json({ error: 'Unable to generate unique code' });
    }

    const sql = `INSERT INTO links (code, target_url) VALUES (?, ?)`;
    await pool.query(sql, [shortCode, target_url]);

    const [rows] = await pool.query('SELECT code, target_url, total_clicks, last_clicked, created_at FROM links WHERE code = ?', [shortCode]);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Code already exists' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

async function codeExists(pool, code) {
  const [rows] = await pool.query('SELECT 1 FROM links WHERE code = ? LIMIT 1', [code]);
  return rows.length > 0;
}

// List
app.get('/api/links', async (req, res) => {
  const [rows] = await pool.query('SELECT code, target_url, total_clicks, last_clicked, created_at FROM links WHERE deleted = 0 OR deleted IS NULL ORDER BY created_at DESC');
  res.json(rows);
});

// Stats
app.get('/api/links/:code', async (req, res) => {
  const code = req.params.code;
  const [rows] = await pool.query('SELECT code, target_url, total_clicks, last_clicked, created_at FROM links WHERE code = ? AND (deleted = 0 OR deleted IS NULL) LIMIT 1', [code]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

// Delete
app.delete('/api/links/:code', async (req, res) => {
  const code = req.params.code;
  const [result] = await pool.query('DELETE FROM links WHERE code = ?', [code]); // or UPDATE deleted=1
  if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
});

// Redirect
app.get('/:code', async (req, res) => {
  const code = req.params.code;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT id, target_url FROM links WHERE code = ? AND (deleted = 0 OR deleted IS NULL) LIMIT 1', [code]);
    if (!rows.length) { await conn.rollback(); return res.status(404).send('Not found'); }
    const link = rows[0];
    await conn.query('UPDATE links SET total_clicks = total_clicks + 1, last_clicked = NOW() WHERE id = ?', [link.id]);
    await conn.commit();
    return res.redirect(302, link.target_url);
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).send('Server error');
  } finally {
    conn.release();
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log('Server listening on', PORT));
