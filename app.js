const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
const multer = require('multer');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

const JWT_SECRET = 'straywatch_secret_key_change_this_later';

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1000) + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// Database connection
const fs = require('fs');

const db = mysql.createConnection({
  host: 'straywatch-straywatch.c.aivencloud.com',
  port: 12864,
  user: 'avnadmin',
  password: process.env.DB_PASSWORD,
  database: 'defaultdb',
  ssl: {
    ca: fs.readFileSync('./ca.pem')
  }
});

db.connect((err) => {
  if (err) console.error('Database connection failed:', err);
  else console.log('Connected to MySQL database.');
});

// Auto-create tables (run once, then you can remove this)
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
    image_url VARCHAR(255),
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

  db.query(userTable, (err) => { if (err) console.error('Users table error:', err); else console.log('Users table ready.'); });
  db.query(reportTable, (err) => { if (err) console.error('Reports table error:', err); else console.log('Reports table ready.'); });
  db.query(flagTable, (err) => { if (err) console.error('Flags table error:', err); else console.log('Flags table ready.'); });
};

createTables();

// Middleware to verify JWT token
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided.' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Invalid token.' });
    req.user = decoded;
    next();
  });
};

// Front door
app.get('/', (req, res) => {
  res.send('StrayWatch PH server is alive.');
});

// SIGNUP
app.post('/auth/signup', async (req, res) => {
  const { email, password, role } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required.' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const sql = 'INSERT INTO users (email, password, role) VALUES (?, ?, ?)';
  db.query(sql, [email, hashedPassword, role || 'reporter'], (err, result) => {
    if (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Email already registered.' });
      }
      return res.status(500).json({ error: 'Signup failed.' });
    }

    const token = jwt.sign(
      { id: result.insertId, email, role: role || 'reporter' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({ token, user: { id: result.insertId, email, role: role || 'reporter' } });
  });
});

// LOGIN
app.post('/auth/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required.' });
  }

  db.query('SELECT * FROM users WHERE email = ?', [email], async (err, results) => {
    if (err || results.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = results[0];
    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
  });
});

// POST - Create a report (requires login)
app.post('/reports', authenticate, upload.single('photo'), (req, res) => {
  const { dogType, location, description, latitude, longitude } = req.body;
  const userId = req.user.id;
  const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

  const sql = 'INSERT INTO reports (dog_type, location, description, image_url, latitude, longitude, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)';
  const values = [dogType, location, description, imageUrl, latitude || null, longitude || null, userId];

  db.query(sql, values, (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to save report.' });
    }

    const newReport = {
      id: result.insertId,
      dogType,
      location,
      description,
      imageUrl,
      latitude: latitude || null,
      longitude: longitude || null,
      status: 'Open',
      createdAt: new Date(),
      userId
    };

    res.status(201).json(newReport);
  });
});

// GET - All reports (hides flagged reports for non-responders)
app.get('/reports', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  let userRole = 'reporter';

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userRole = decoded.role;
    } catch (err) {
      // Invalid token, treat as reporter
    }
  }

  let sql = 'SELECT * FROM reports';
  
  // Reporters don't see flagged reports
  if (userRole !== 'responder') {
    sql += ' WHERE is_flagged = FALSE';
  }
  
  sql += ' ORDER BY created_at DESC';

  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch reports.' });

    const reports = results.map(row => ({
      id: row.id,
      dogType: row.dog_type,
      location: row.location,
      description: row.description,
      imageUrl: row.image_url,
      status: row.status,
      latitude: row.latitude,
      longitude: row.longitude,
      userId: row.user_id,
      isFlagged: row.is_flagged,
      flagCount: row.flag_count,
      createdAt: row.created_at
    }));

    // Add duplicate info for each Open report
    const openReports = reports.filter(r => r.status === 'Open' && r.latitude && r.longitude);
    
    const reportsWithDuplicates = reports.map(report => {
      if (report.status !== 'Open' || !report.latitude || !report.longitude) {
        return { ...report, hasDuplicates: false, duplicateCount: 0 };
      }

      let duplicateCount = 0;
      openReports.forEach(other => {
        if (other.id !== report.id) {
          const distance = getDistance(
            report.latitude, report.longitude,
            other.latitude, other.longitude
          );
          if (distance < 0.2) { // 200 meters
            duplicateCount++;
          }
        }
      });

      return {
        ...report,
        hasDuplicates: duplicateCount > 0,
        duplicateCount
      };
    });

    res.json(reportsWithDuplicates);
  });
});

// Helper function to calculate distance between two coordinates in km
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// POST - Flag a report as inappropriate
app.post('/reports', authenticate, upload.single('photo'), (req, res) => {
  const { dogType, location, description, latitude, longitude } = req.body;
  const userId = req.user.id;
  const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

  // Check for duplicates if coordinates provided
  if (latitude && longitude) {
    db.query(
      'SELECT id, latitude, longitude FROM reports WHERE status = "Open" AND latitude IS NOT NULL AND longitude IS NOT NULL',
      (err, existing) => {
        if (err) return res.status(500).json({ error: 'Database error.' });

        let nearbyCount = 0;
        existing.forEach(report => {
          const dist = getDistance(
            parseFloat(latitude), parseFloat(longitude),
            parseFloat(report.latitude), parseFloat(report.longitude)
          );
          if (dist < 0.2) nearbyCount++;
        });

        if (nearbyCount > 0) {
          return res.status(409).json({
            error: 'duplicate',
            message: `There ${nearbyCount === 1 ? 'is' : 'are'} already ${nearbyCount} open report${nearbyCount === 1 ? '' : 's'} near this location. Please confirm this is a different dog before submitting.`,
            nearbyCount
          });
        }

        insertReport();
      }
    );
  } else {
    insertReport();
  }

  function insertReport() {
    const sql = 'INSERT INTO reports (dog_type, location, description, image_url, latitude, longitude, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)';
    const values = [dogType, location, description, imageUrl, latitude || null, longitude || null, userId];

    db.query(sql, values, (err, result) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to save report.' });
      }

      const newReport = {
        id: result.insertId,
        dogType,
        location,
        description,
        imageUrl,
        latitude: latitude || null,
        longitude: longitude || null,
        status: 'Open',
        createdAt: new Date(),
        userId
      };

      res.status(201).json(newReport);
    });
  }
});

app.listen(3000, () => {
  console.log('Server is running on http://localhost:3000');
});