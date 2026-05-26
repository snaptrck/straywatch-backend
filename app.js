const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = 'straywatch_secret_key_change_this_later';

const db = mysql.createConnection({
  host: 'straywatch-straywatch.c.aivencloud.com',
  port: 12864,
  user: 'avnadmin',
  password: process.env.DB_PASSWORD,
  database: 'defaultdb',
  ssl: { ca: fs.readFileSync('./ca.pem') }
});

db.connect((err) => {
  if (err) console.error('Database connection failed:', err);
  else console.log('Connected to MySQL database.');
});

const createTables = () => {
  const userTable = `CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'reporter',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`;
  const reportTable = `CREATE TABLE IF NOT EXISTS reports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    dog_type VARCHAR(50) NOT NULL,
    location VARCHAR(255) NOT NULL,
    description TEXT,
    image_url VARCHAR(1000),
    status VARCHAR(50) DEFAULT 'Open',
    latitude DECIMAL(10, 8) NULL,
    longitude DECIMAL(11, 8) NULL,
    user_id INT NULL,
    is_flagged BOOLEAN DEFAULT FALSE,
    flag_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`;
  const flagTable = `CREATE TABLE IF NOT EXISTS flags (
    id INT AUTO_INCREMENT PRIMARY KEY,
    report_id INT NOT NULL,
    user_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (report_id) REFERENCES reports(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE KEY unique_flag (report_id, user_id)
  )`;
  db.query(userTable, (err) => { if (err) console.error(err); else console.log('Users table ready.'); });
  db.query(reportTable, (err) => { if (err) console.error(err); else console.log('Reports table ready.'); });
  db.query(flagTable, (err) => { if (err) console.error(err); else console.log('Flags table ready.'); });
};
createTables();

const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided.' });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Invalid token.' });
    req.user = decoded;
    next();
  });
};

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

app.get('/', (req, res) => { res.send('StrayWatch PH server is alive.'); });

app.post('/auth/signup', async (req, res) => {
  const { email, password, role } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  const hashedPassword = await bcrypt.hash(password, 10);
  db.query('INSERT INTO users (email, password, role) VALUES (?, ?, ?)', [email, hashedPassword, role || 'reporter'], (err, result) => {
    if (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email already registered.' });
      return res.status(500).json({ error: 'Signup failed.' });
    }
    const token = jwt.sign({ id: result.insertId, email, role: role || 'reporter' }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { id: result.insertId, email, role: role || 'reporter' } });
  });
});

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  db.query('SELECT * FROM users WHERE email = ?', [email], async (err, results) => {
    if (err || results.length === 0) return res.status(401).json({ error: 'Invalid email or password.' });
    const user = results[0];
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Invalid email or password.' });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
  });
});

app.post('/reports', authenticate, (req, res) => {
  console.log('DEBUG Body:', req.body);
  const { dogType, location, description, latitude, longitude, imageUrl } = req.body;
  const userId = req.user.id;
  const sql = 'INSERT INTO reports (dog_type, location, description, image_url, latitude, longitude, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)';
  const values = [dogType, location, description, imageUrl || null, latitude || null, longitude || null, userId];
  db.query(sql, values, (err, result) => {
    if (err) {
      console.error('Insert error:', err);
      return res.status(500).json({ error: 'Failed to save report.' });
    }
    res.status(201).json({ id: result.insertId, dogType, location, description, imageUrl, latitude, longitude, status: 'Open', createdAt: new Date(), userId });
  });
});

app.get('/reports', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  let userRole = 'reporter';
  if (token) { try { const d = jwt.verify(token, JWT_SECRET); userRole = d.role; } catch(e) {} }
  let sql = 'SELECT * FROM reports';
  if (userRole !== 'responder') sql += ' WHERE is_flagged = FALSE';
  sql += ' ORDER BY created_at DESC';
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch reports.' });
    const reports = results.map(r => ({
      id: r.id, dogType: r.dog_type, location: r.location, description: r.description,
      imageUrl: r.image_url, status: r.status, latitude: r.latitude, longitude: r.longitude,
      userId: r.user_id, isFlagged: r.is_flagged, flagCount: r.flag_count, createdAt: r.created_at
    }));
    res.json(reports);
  });
});

app.patch('/reports/:id', authenticate, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (req.user.role !== 'responder') return res.status(403).json({ error: 'Only responders can update reports.' });
  db.query('UPDATE reports SET status = ? WHERE id = ?', [status, id], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to update report.' });
    res.json({ message: 'Status updated', id, status });
  });
});

app.post('/reports/:id/flag', authenticate, (req, res) => {
  const reportId = req.params.id;
  const userId = req.user.id;
  db.query('SELECT * FROM flags WHERE report_id = ? AND user_id = ?', [reportId, userId], (err, results) => {
    if (err) return res.status(500).json({ error: 'Database error.' });
    if (results.length > 0) return res.status(400).json({ error: 'You already flagged this report.' });
    db.query('INSERT INTO flags (report_id, user_id) VALUES (?, ?)', [reportId, userId], (err) => {
      if (err) return res.status(500).json({ error: 'Failed to flag report.' });
      db.query('UPDATE reports SET flag_count = flag_count + 1 WHERE id = ?', [reportId], (err) => {
        if (err) return res.status(500).json({ error: 'Failed to update flag count.' });
        db.query('UPDATE reports SET is_flagged = TRUE WHERE id = ? AND flag_count >= 3', [reportId], (err) => {
          if (err) return res.status(500).json({ error: 'Failed to hide report.' });
          res.json({ message: 'Report flagged successfully.' });
        });
      });
    });
  });
});

app.listen(3000, () => { console.log('Server is running on http://localhost:3000'); });