require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

// Email setup - ZeptoMail
async function sendEmail({ to, subject, text, attachments = [] }) {
  const token = process.env.ZEPTOMAIL_TOKEN;
  if (!token) throw new Error('ZEPTOMAIL_TOKEN not configured');

  const html = text.replace(/\n/g, '<br>');

  const body = {
    from: { address: 'info@ecodos.co.il', name: 'ECODOS' },
    to: [{ email_address: { address: to } }],
    subject: subject,
    htmlbody: html
  };

  const response = await fetch('https://api.zeptomail.com/v1.1/email', {
    method: 'POST',
    headers: {
      'Authorization': `Zoho-enczapikey ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ZeptoMail error: ${err}`);
  }

  console.log(`✅ מייל נשלח ל-${to}`);
  return await response.json();
}

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Railway proxy
app.set('trust proxy', 1);

// Middleware
app.use(cors({
  origin: ['https://ecodos.co.il', 'https://www.ecodos.co.il', 'http://localhost:3000', 'http://127.0.0.1:5500'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Handle preflight requests
app.options('*', cors());

app.use(express.json({ limit: '10mb' }));

// Rate limiting - הגבלת קצב בקשות
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 דקות
  max: 500, // מקסימום 100 בקשות לכל IP
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }
});
app.use('/api/', limiter);

// חיבור לדאטאבייס PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// הגדרת timezone לישראל
pool.on('connect', (client) => {
  client.query('SET timezone = "Asia/Jerusalem"');
});

// בדיקת חיבור לדאטאבייס
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ שגיאה בחיבור לדאטאבייס:', err.stack);
  } else {
    console.log('✅ התחברות לדאטאבייס הצליחה');
    release();
  }
});

// יצירת טבלאות אם לא קיימות
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // טבלת מוצרים
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        short_description VARCHAR(500),
        price DECIMAL(10, 2) NOT NULL,
        sale_price DECIMAL(10, 2),
        price_label VARCHAR(100),
        in_stock BOOLEAN DEFAULT true,
        stock_quantity INTEGER DEFAULT 0,
        has_warranty BOOLEAN DEFAULT false,
        image_url TEXT,
        category VARCHAR(100),
        sku VARCHAR(100) UNIQUE,
        badge VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // הוספת שדות חדשים לטבלת products אם לא קיימים (לטבלאות קיימות)
    await client.query(`
      DO $$ 
      BEGIN 
        -- תיאור קצר
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='short_description') THEN
          ALTER TABLE products ADD COLUMN short_description VARCHAR(500);
        END IF;
        
        -- מחיר מבצע
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='sale_price') THEN
          ALTER TABLE products ADD COLUMN sale_price DECIMAL(10, 2);
        END IF;
        
        -- מלל מחיר
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='price_label') THEN
          ALTER TABLE products ADD COLUMN price_label VARCHAR(100);
        END IF;
        
        -- כמות במלאי
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='stock_quantity') THEN
          ALTER TABLE products ADD COLUMN stock_quantity INTEGER DEFAULT 0;
        END IF;
        
        -- קטגוריה
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='category') THEN
          ALTER TABLE products ADD COLUMN category VARCHAR(100);
        END IF;
        
        -- SKU
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='sku') THEN
          ALTER TABLE products ADD COLUMN sku VARCHAR(100) UNIQUE;
        END IF;
        
        -- תג
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='badge') THEN
          ALTER TABLE products ADD COLUMN badge VARCHAR(50);
        END IF;
      END $$;
    `);

    // עדכון ערכי default למוצרים קיימים
    await client.query(`
      UPDATE products 
      SET stock_quantity = 0 
      WHERE stock_quantity IS NULL
    `);

    // טבלת משתמשים
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        phone VARCHAR(20),
        address TEXT,
        is_admin BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // טבלת הזמנות
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        total_amount DECIMAL(10, 2) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        payment_status VARCHAR(50) DEFAULT 'pending',
        shipping_address TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // טבלת פריטים בהזמנה
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id),
        quantity INTEGER NOT NULL,
        price DECIMAL(10, 2) NOT NULL
      )
    `);

    // טבלת אחריות
    await client.query(`
      CREATE TABLE IF NOT EXISTS warranties (
        id SERIAL PRIMARY KEY,
        serial_number VARCHAR(255) NOT NULL UNIQUE,
        purchase_date DATE NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        customer_phone VARCHAR(20) NOT NULL,
        expiry_date DATE NOT NULL,
        status VARCHAR(50) DEFAULT 'ממתין לאישור',
        registration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        user_id INTEGER REFERENCES users(id),
        receipt_filename VARCHAR(255),
        order_id INTEGER REFERENCES orders(id),
        product_id INTEGER REFERENCES products(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // הוספת עמודת has_warranty למוצרים קיימים אם לא קיימת
    await client.query(`
      DO $$ 
      BEGIN 
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name='products' AND column_name='has_warranty'
        ) THEN
          ALTER TABLE products ADD COLUMN has_warranty BOOLEAN DEFAULT false;
        END IF;
      END $$;
    `);

    // הוספת עמודת reminder_sent לאחריות אם לא קיימת
    await client.query(`
      DO $$ 
      BEGIN 
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name='warranties' AND column_name='reminder_sent'
        ) THEN
          ALTER TABLE warranties ADD COLUMN reminder_sent BOOLEAN DEFAULT false;
        END IF;
      END $$;
    `);


    // הוספת עמודת product_type לאחריות אם לא קיימת
    await client.query(`
      DO $$ 
      BEGIN 
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name='warranties' AND column_name='product_type'
        ) THEN
          ALTER TABLE warranties ADD COLUMN product_type VARCHAR(100);
        END IF;
      END $$;
    `);


    // טבלת סוגי מוצר לתפריט אחריות
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_types (
        id SERIAL PRIMARY KEY,
        value VARCHAR(100) NOT NULL UNIQUE,
        label VARCHAR(255) NOT NULL,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // הוסף ערכי ברירת מחדל אם הטבלה ריקה
    const ptCount = await client.query('SELECT COUNT(*) FROM product_types');
    if (parseInt(ptCount.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO product_types (value, label, sort_order) VALUES
        ('hub', 'בקר ECODOS Hub', 1),
        ('outlet', 'שקע חכם Type H', 2),
        ('switch1', 'מתג חכם 1 כנף', 3),
        ('switch2', 'מתג חכם 2 כנפיים', 4),
        ('boiler', 'לוח בקרת דוד', 5)
      `);
    }


    // טבלת קטגוריות מוצרים
    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        value VARCHAR(100) NOT NULL UNIQUE,
        label VARCHAR(255) NOT NULL,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // הוסף ערכי ברירת מחדל אם הטבלה ריקה
    const catCount = await client.query('SELECT COUNT(*) FROM categories');
    if (parseInt(catCount.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO categories (value, label, sort_order) VALUES
        ('שקעים', 'שקעים חכמים', 1),
        ('מתגים', 'מתגים חכמים', 2),
        ('בקרים', 'בקרים', 3)
      `);
    }

    // טבלת טוקנים לאיפוס סיסמה
    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        token VARCHAR(255) UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // טבלת קבלות (נמחקות אוטומטית אחרי 24 שעות)
    await client.query(`
      CREATE TABLE IF NOT EXISTS receipts (
        id SERIAL PRIMARY KEY,
        warranty_id INTEGER REFERENCES warranties(id) ON DELETE CASCADE,
        filename VARCHAR(255) NOT NULL,
        file_data BYTEA NOT NULL,
        content_type VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // טבלת לוג שינויי מלאי
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_logs (
        id SERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        change_amount INTEGER NOT NULL,
        reason VARCHAR(255),
        order_id INTEGER REFERENCES orders(id),
        admin_id INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query('COMMIT');
    console.log('✅ טבלאות נוצרו בהצלחה');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ שגיאה ביצירת טבלאות:', err);
  } finally {
    client.release();
  }
}

// Middleware לאימות JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'נדרש token' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Token לא תקין' });
    }
    req.user = user;
    next();
  });
}

// Middleware לבדיקת הרשאות admin
function requireAdmin(req, res, next) {
  if (!req.user.is_admin) {
    return res.status(403).json({ error: 'נדרשות הרשאות אדמין' });
  }
  next();
}

// ========== API ENDPOINTS ==========

// בדיקת תקינות
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// ===== מוצרים =====

// קבלת כל המוצרים (ציבורי)
app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM products WHERE in_stock = true ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בשליפת מוצרים' });
  }
});

// קבלת כל המוצרים (admin - כולל לא במלאי)
app.get('/api/admin/all-products', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM products ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בשליפת מוצרים' });
  }
});

// קבלת מוצר בודד
app.get('/api/products/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'מוצר לא נמצא' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בשליפת מוצר' });
  }
});

// הוספת מוצר (admin בלבד)
app.post('/api/admin/products', authenticateToken, requireAdmin, async (req, res) => {
  const { 
    name, description, short_description, price, sale_price, price_label, 
    in_stock, stock_quantity, has_warranty, image_url, category, sku, badge 
  } = req.body;

  if (!name || !price) {
    return res.status(400).json({ error: 'שם ומחיר הם שדות חובה' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO products 
       (name, description, short_description, price, sale_price, price_label, 
        in_stock, stock_quantity, has_warranty, image_url, category, sku, badge) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) 
       RETURNING *`,
      [name, description, short_description, price, sale_price || null, price_label || null,
       in_stock !== false, stock_quantity || 0, has_warranty || false, image_url, 
       category || null, sku || null, badge || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') { // Unique constraint violation (SKU)
      return res.status(400).json({ error: 'SKU זה כבר קיים במערכת' });
    }
    res.status(500).json({ error: 'שגיאה בהוספת מוצר' });
  }
});

// עדכון מוצר (admin בלבד)
app.put('/api/admin/products/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { 
    name, description, short_description, price, sale_price, price_label,
    in_stock, stock_quantity, has_warranty, image_url, category, sku, badge 
  } = req.body;

  try {
    const result = await pool.query(
      `UPDATE products SET 
       name = $1, description = $2, short_description = $3, price = $4, 
       sale_price = $5, price_label = $6, in_stock = $7, stock_quantity = $8,
       has_warranty = $9, image_url = $10, category = $11, sku = $12, badge = $13
       WHERE id = $14 RETURNING *`,
      [name, description, short_description, price, sale_price, price_label,
       in_stock, stock_quantity, has_warranty, image_url, category, sku, badge,
       req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'מוצר לא נמצא' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'SKU זה כבר קיים במערכת' });
    }
    res.status(500).json({ error: 'שגיאה בעדכון מוצר' });
  }
});

// מחיקת מוצר (admin בלבד)
app.delete('/api/admin/products/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM products WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'מוצר לא נמצא' });
    }
    res.json({ message: 'מוצר נמחק בהצלחה' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה במחיקת מוצר' });
  }
});

// התראות מלאי נמוך (admin)
app.get('/api/admin/low-stock', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const threshold = req.query.threshold || 10; // ברירת מחדל: 10 יחידות
    const result = await pool.query(
      'SELECT * FROM products WHERE stock_quantity <= $1 AND stock_quantity > 0 ORDER BY stock_quantity ASC',
      [threshold]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בשליפת מלאי נמוך' });
  }
});

// עדכון מלאי ידני (admin)
app.post('/api/admin/update-stock', authenticateToken, requireAdmin, async (req, res) => {
  const { product_id, change_amount, reason } = req.body;

  if (!product_id || change_amount === undefined) {
    return res.status(400).json({ error: 'נדרשים product_id ו-change_amount' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // עדכון המלאי
    const result = await client.query(
      'UPDATE products SET stock_quantity = stock_quantity + $1 WHERE id = $2 RETURNING *',
      [change_amount, product_id]
    );

    if (result.rows.length === 0) {
      throw new Error('מוצר לא נמצא');
    }

    // רישום בלוג
    await client.query(
      `INSERT INTO stock_logs (product_id, change_amount, reason, admin_id) 
       VALUES ($1, $2, $3, $4)`,
      [product_id, change_amount, reason || 'עדכון ידני', req.user.id]
    );

    await client.query('COMMIT');
    res.json({ 
      message: 'מלאי עודכן בהצלחה',
      product: result.rows[0]
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה בעדכון מלאי' });
  } finally {
    client.release();
  }
});

// לוג שינויי מלאי (admin)
app.get('/api/admin/stock-logs/:product_id?', authenticateToken, requireAdmin, async (req, res) => {
  try {
    let query, params;
    
    if (req.params.product_id) {
      // לוג של מוצר ספציפי
      query = `
        SELECT sl.*, p.name as product_name, u.full_name as admin_name
        FROM stock_logs sl
        LEFT JOIN products p ON sl.product_id = p.id
        LEFT JOIN users u ON sl.admin_id = u.id
        WHERE sl.product_id = $1
        ORDER BY sl.created_at DESC
        LIMIT 100
      `;
      params = [req.params.product_id];
    } else {
      // כל הלוגים
      query = `
        SELECT sl.*, p.name as product_name, u.full_name as admin_name
        FROM stock_logs sl
        LEFT JOIN products p ON sl.product_id = p.id
        LEFT JOIN users u ON sl.admin_id = u.id
        ORDER BY sl.created_at DESC
        LIMIT 200
      `;
      params = [];
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בשליפת לוג מלאי' });
  }
});

// ===== משתמשים =====

// הרשמה
app.post('/api/auth/register', async (req, res) => {
  const { email, password, full_name, phone, address } = req.body;

  if (!email || !password || !full_name) {
    return res.status(400).json({ error: 'אימייל, סיסמה ושם מלא הם שדות חובה' });
  }

  try {
    // בדיקה אם המשתמש כבר קיים
    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'משתמש עם אימייל זה כבר קיים' });
    }

    // הצפנת סיסמה
    const password_hash = await bcrypt.hash(password, 10);

    // יצירת משתמש חדש
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, full_name, phone, address) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, full_name, phone, address, is_admin',
      [email, password_hash, full_name, phone, address]
    );

    const user = result.rows[0];

    // יצירת JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email, is_admin: user.is_admin },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({ user, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה ביצירת משתמש' });
  }
});

// התחברות
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'אימייל וסיסמה הם שדות חובה' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'אימייל או סיסמה שגויים' });
    }

    const user = result.rows[0];

    // בדיקת סיסמה
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'אימייל או סיסמה שגויים' });
    }

    // יצירת JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email, is_admin: user.is_admin },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        phone: user.phone,
        address: user.address,
        is_admin: user.is_admin
      },
      token
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בהתחברות' });
  }
});

// שכחתי סיסמה - שליחת מייל עם קישור איפוס
app.post('/api/auth/forgot-password', async (req, res) => {
  console.log('📧 Forgot password request received for:', req.body.email);
  
  // בדיקה אם nodemailer זמין
  if (!transporter) {
    console.error('❌ Transporter not configured');
    return res.status(503).json({ 
      error: 'שירות איפוס סיסמה אינו זמין כרגע. אנא פנה לתמיכה.' 
    });
  }

  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'נדרש אימייל' });
  }

  try {
    console.log('🔍 Looking up user:', email);
    // בדיקה אם המשתמש קיים
    const userResult = await pool.query('SELECT id, full_name FROM users WHERE email = $1', [email]);
    
    if (userResult.rows.length === 0) {
      console.log('⚠️ User not found:', email);
      // אבטחה: לא מגלים שהאימייל לא קיים
      return res.json({ message: 'אם האימייל קיים במערכת, נשלח אליו קישור לאיפוס סיסמה' });
    }

    const user = userResult.rows[0];
    console.log('✅ User found:', user.id);

    // יצירת טוקן אקראי
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3600000); // שעה אחת

    console.log('💾 Saving token to database');
    // שמירת הטוקן בדאטאבייס
    await pool.query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, resetToken, expiresAt]
    );

    // יצירת קישור איפוס (יעודכן לפי הדומיין שלך)
    const resetLink = `https://ecodos.co.il/reset-password?token=${resetToken}`;

    console.log('📮 Attempting to send email to:', email);
    // שליחת מייל
    const mailOptions = {
      from: process.env.SMTP_USER,
      to: email,
      subject: 'איפוס סיסמה - פונפלה',
      html: `
        <div dir="rtl" style="font-family: Arial, sans-serif; text-align: right;">
          <h2>שלום ${user.full_name},</h2>
          <p>קיבלנו בקשה לאיפוס הסיסמה שלך באתר פונפלה.</p>
          <p>לחץ על הכפתור למטה כדי לאפס את הסיסמה:</p>
          <p style="text-align: center;">
            <a href="${resetLink}" 
               style="display: inline-block; padding: 12px 30px; background: #667eea; 
                      color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">
              אפס סיסמה
            </a>
          </p>
          <p>או העתק את הקישור הזה לדפדפן:</p>
          <p style="word-break: break-all;">${resetLink}</p>
          <p><strong>הקישור תקף לשעה אחת בלבד.</strong></p>
          <p>אם לא ביקשת לאפס סיסמה, התעלם מהמייל הזה.</p>
          <hr style="margin: 20px 0; border: none; border-top: 1px solid #ddd;">
          <p style="font-size: 12px; color: #666;">פונפלה - כל אמא יכולה</p>
        </div>
      `
    };

    await sendEmail({
      to: email,
      subject: mailOptions.subject,
      text: mailOptions.html.replace(/<[^>]*>/g, '') // Convert HTML to text for nodemailer fallback
    });
    console.log('✅ Email sent successfully to:', email);

    res.json({ message: 'אם האימייל קיים במערכת, נשלח אליו קישור לאיפוס סיסמה' });
  } catch (err) {
    console.error('❌ ERROR in forgot-password:');
    console.error('Error message:', err.message);
    console.error('Error code:', err.code);
    console.error('Full error:', err);
    res.status(500).json({ error: 'שגיאה בשליחת מייל' });
  }
});

// איפוס סיסמה עם טוקן
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, new_password } = req.body;

  if (!token || !new_password) {
    return res.status(400).json({ error: 'נדרשים טוקן וסיסמה חדשה' });
  }

  if (new_password.length < 6) {
    return res.status(400).json({ error: 'הסיסמה חייבת להכיל לפחות 6 תווים' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // בדיקת הטוקן
    const tokenResult = await client.query(
      'SELECT * FROM password_reset_tokens WHERE token = $1 AND used = false AND expires_at > NOW()',
      [token]
    );

    if (tokenResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'טוקן לא תקין או פג תוקף' });
    }

    const resetToken = tokenResult.rows[0];

    // הצפנת הסיסמה החדשה
    const password_hash = await bcrypt.hash(new_password, 10);

    // עדכון הסיסמה
    await client.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [password_hash, resetToken.user_id]
    );

    // סימון הטוקן כמשומש
    await client.query(
      'UPDATE password_reset_tokens SET used = true WHERE id = $1',
      [resetToken.id]
    );

    await client.query('COMMIT');

    res.json({ message: 'הסיסמה עודכנה בהצלחה' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'שגיאה באיפוס סיסמה' });
  } finally {
    client.release();
  }
});

// קבלת פרטי משתמש (דורש אימות)
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, full_name, phone, address, is_admin FROM users WHERE id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'משתמש לא נמצא' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בשליפת פרטי משתמש' });
  }
});

// עדכון פרטי משתמש
app.put('/api/user/profile', authenticateToken, async (req, res) => {
  const { full_name, phone, address } = req.body;

  try {
    const result = await pool.query(
      'UPDATE users SET full_name = $1, phone = $2, address = $3 WHERE id = $4 RETURNING id, email, full_name, phone, address',
      [full_name, phone, address, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בעדכון פרטים' });
  }
});

// שינוי סיסמה
app.put('/api/user/change-password', authenticateToken, async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'נדרשים סיסמה נוכחית וסיסמה חדשה' });
  }

  if (new_password.length < 6) {
    return res.status(400).json({ error: 'הסיסמה החדשה חייבת להכיל לפחות 6 תווים' });
  }

  try {
    // שליפת המשתמש מהדאטאבייס
    const userResult = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'משתמש לא נמצא' });
    }

    const user = userResult.rows[0];

    // בדיקת הסיסמה הנוכחית
    const validPassword = await bcrypt.compare(current_password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'הסיסמה הנוכחית שגויה' });
    }

    // הצפנת הסיסמה החדשה
    const new_password_hash = await bcrypt.hash(new_password, 10);

    // עדכון הסיסמה בדאטאבייס
    await pool.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [new_password_hash, req.user.id]
    );

    res.json({ message: 'הסיסמה עודכנה בהצלחה' });
  } catch (err) {
    console.error('שגיאה בשינוי סיסמה:', err);
    res.status(500).json({ error: 'שגיאה בשינוי סיסמה' });
  }
});

// ===== הזמנות =====

// יצירת הזמנה חדשה
app.post('/api/orders', authenticateToken, async (req, res) => {
  const { items, shipping_address } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'ההזמנה חייבת לכלול מוצרים' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // בדיקת מלאי ראשונית
    for (const item of items) {
      const productResult = await client.query(
        'SELECT stock_quantity, name FROM products WHERE id = $1',
        [item.product_id]
      );
      if (productResult.rows.length === 0) {
        throw new Error(`מוצר ${item.product_id} לא נמצא`);
      }
      const product = productResult.rows[0];
      if (product.stock_quantity < item.quantity) {
        throw new Error(`אין מספיק מלאי עבור ${product.name}. נשארו ${product.stock_quantity} יחידות`);
      }
    }

    // חישוב סכום כולל
    let total_amount = 0;
    for (const item of items) {
      const productResult = await client.query(
        'SELECT price, sale_price FROM products WHERE id = $1', 
        [item.product_id]
      );
      const finalPrice = productResult.rows[0].sale_price || productResult.rows[0].price;
      total_amount += finalPrice * item.quantity;
    }

    // יצירת הזמנה
    const orderResult = await client.query(
      'INSERT INTO orders (user_id, total_amount, shipping_address) VALUES ($1, $2, $3) RETURNING *',
      [req.user.id, total_amount, shipping_address]
    );
    const order = orderResult.rows[0];

    // הוספת פריטים להזמנה + הורדת מלאי
    for (const item of items) {
      const productResult = await client.query(
        'SELECT price, sale_price, has_warranty, name, stock_quantity FROM products WHERE id = $1', 
        [item.product_id]
      );
      const product = productResult.rows[0];
      const finalPrice = product.sale_price || product.price;
      
      await client.query(
        'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ($1, $2, $3, $4)',
        [order.id, item.product_id, item.quantity, finalPrice]
      );

      // הורדת מלאי אוטומטית
      await client.query(
        'UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2',
        [item.quantity, item.product_id]
      );

      // רישום בלוג
      await client.query(
        `INSERT INTO stock_logs (product_id, change_amount, reason, order_id) 
         VALUES ($1, $2, $3, $4)`,
        [item.product_id, -item.quantity, `הזמנה #${order.id}`, order.id]
      );

      // יצירת אחריות אוטומטית למוצרים עם has_warranty=true
      if (product.has_warranty) {
        const userResult = await client.query(
          'SELECT full_name, phone FROM users WHERE id = $1',
          [req.user.id]
        );
        const user = userResult.rows[0];

        const purchase_date = new Date();
        const expiry_date = new Date(purchase_date);
        expiry_date.setFullYear(expiry_date.getFullYear() + 1);
        expiry_date.setDate(expiry_date.getDate() + 1);

        const machineNumber = Math.floor(1000000000 + Math.random() * 9000000000).toString();

        await client.query(
          `INSERT INTO warranties 
           (serial_number, purchase_date, customer_name, customer_phone, expiry_date, 
            status, user_id, order_id, product_id) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [machineNumber, purchase_date, user.full_name, user.phone, expiry_date, 
           'בתוקף', req.user.id, order.id, item.product_id]
        );
      }
    }
// שליחת מייל ללקוח ולאדמין
    const userEmailResult = await client.query('SELECT email, full_name FROM users WHERE id = $1', [req.user.id]);
    const userEmail = userEmailResult.rows[0];
    const itemsList = items.map(i => `${i.name} x${i.quantity} — ₪${i.price}`).join('\n');
    sendEmail({
      to: userEmail.email,
      subject: `אישור הזמנה #${order.id} - ECODOS`,
      text: `שלום ${userEmail.full_name},\n\nהזמנתך התקבלה ואנחנו בטיפול!\n\nמספר הזמנה: ${order.id}\n\nפריטים:\n${itemsList}\n\nסכום כולל: ₪${total_amount}\n\nניצור איתך קשר בקרוב.\n\nתודה,\nצוות ECODOS`
    }).catch(console.error);
    sendEmail({
      to: 'info@ecodos.co.il',
      subject: `הזמנה חדשה #${order.id} - ${userEmail.full_name}`,
      text: `התקבלה הזמנה חדשה!\n\nלקוח: ${userEmail.full_name}\nאימייל: ${userEmail.email}\n\nפריטים:\n${itemsList}\n\nסכום: ₪${total_amount}`
    }).catch(console.error);
    await client.query('COMMIT');
    res.status(201).json(order);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message || 'שגיאה ביצירת הזמנה' });
  } finally {
    client.release();
  }
});

// קבלת כל ההזמנות של משתמש
app.get('/api/user/orders', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, 
        json_agg(json_build_object(
          'product_id', oi.product_id,
          'product_name', p.name,
          'quantity', oi.quantity,
          'price', oi.price
        )) as items
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE o.user_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בשליפת הזמנות' });
  }
});

// קבלת הזמנה בודדת
app.get('/api/orders/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, 
        json_agg(json_build_object(
          'product_id', oi.product_id,
          'product_name', p.name,
          'quantity', oi.quantity,
          'price', oi.price
        )) as items
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE o.id = $1 AND o.user_id = $2
       GROUP BY o.id`,
      [req.params.id, req.user.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בשליפת הזמנה' });
  }
});

// ===== אחריות =====

// קבלת כל האחריות של משתמש
app.get('/api/user/warranties', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, serial_number, purchase_date, customer_name, customer_phone, 
              expiry_date, status, registration_date
       FROM warranties
       WHERE user_id = $1
       ORDER BY registration_date DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בשליפת אחריות' });
  }
});

// רישום אחריות חדשה (ציבורי או מחובר)
app.post('/api/warranty/register', async (req, res) => {
  const { machineNumber, fullName, phone, purchaseDate, receipt, receiptName, receiptType, website, productType } = req.body;

  // אנטי-ספאם: בדיקת honeypot
  if (website && website !== '') {
    console.log('Honeypot triggered:', website);
    return res.status(400).json({ success: false, message: 'שגיאה בעיבוד הטופס' });
  }

  // בדיקת שדות חובה
  if (!machineNumber || !fullName || !phone || !purchaseDate) {
    return res.status(400).json({ success: false, message: 'חסרים שדות חובה' });
  }

  // בדיקה אם המשתמש מחובר (אופציונלי)
  let userId = null;
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      userId = decoded.id;
    } catch (err) {
      // אם הטוקן לא תקף, ממשיכים בלי user_id
      console.log('Invalid token, registering without user_id');
    }
  }

  try {
    // בדיקה אם מספר המכשיר כבר קיים
    const existing = await pool.query('SELECT id FROM warranties WHERE serial_number = $1', [machineNumber]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ 
        success: false, 
        message: 'מספר סריאלי זה כבר רשום במערכת' 
      });
    }

    // חישוב תאריך תפוגת אחריות (שנה ויום)
    const purchase = new Date(purchaseDate);
    const expiry = new Date(purchase);
    expiry.setFullYear(expiry.getFullYear() + 1);
    expiry.setDate(expiry.getDate() + 1);

    // הכנסת האחריות
    const result = await pool.query(
      `INSERT INTO warranties 
       (serial_number, purchase_date, customer_name, customer_phone, expiry_date, 
        status, user_id, receipt_filename) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
       RETURNING *`,
      [machineNumber, purchase, fullName, phone, expiry, 'ממתין לאישור', userId, receiptName, productType]
    );

    const warrantyId = result.rows[0].id;
    let receiptUrl = null;

    // שמירת הקבלה ב-DB + יצירת קישור
    if (receipt && receiptName && receiptType) {
      try {
        const receiptBuffer = Buffer.from(receipt, 'base64');
        
        const receiptResult = await pool.query(
          `INSERT INTO receipts (warranty_id, filename, file_data, content_type) 
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [warrantyId, receiptName, receiptBuffer, receiptType]
        );
        
        receiptUrl = `https://ecodos-backend-production.up.railway.app/api/receipt/${receiptResult.rows[0].id}`;
        console.log('✅ קבלה נשמרה:', receiptUrl);
      } catch (receiptErr) {
        console.error('❌ שגיאה בשמירת קבלה:', receiptErr);
      }
    }

    // שליחת מייל עם קישור לקבלה - ברקע
    if (transporter || emailService) {
      const emailText = 
        `מכשיר חדש נרשם למערכת:\n\n` +
        `מספר סריאלי: ${machineNumber}\n` +
        `שם לקוח: ${fullName}\n` +
        `טלפון: ${phone}\n` +
        `תאריך רכישה: ${purchase.toLocaleDateString('he-IL')}\n` +
        `תוקף אחריות: ${expiry.toLocaleDateString('he-IL')}\n\n` +
        (receiptUrl ? `קבלה: ${receiptUrl}\n(הקישור תקף ל-24 שעות)\n\n` : 'לא צורפה קבלה\n\n') +
        `הסטטוס: ממתין לאישור\n` +
        `אם לא תאשר תוך 24 שעות, המכשיר יאושר אוטומטית.`;
      
      // שולח ברקע
      sendEmail({
        to: 'info@ecodos.co.il',
        subject: 'רישום מכשיר חדש - פונפלה',
        text: emailText
      }).then(() => {
        console.log('✅ מייל נשלח בהצלחה:', machineNumber);
      }).catch((emailError) => {
        console.error('❌ שגיאה בשליחת מייל:', emailError);
      });
    }

    // מחזירים תשובה מיד - לא מחכים למייל!
    res.status(201).json({ 
      success: true, 
      message: 'המכשיר נרשם בהצלחה',
      warranty: result.rows[0]
    });

  } catch (err) {
    console.error('Error registering warranty:', err);
    res.status(500).json({ success: false, message: 'שגיאה ברישום אחריות' });
  }
});

// צפייה בקבלה (ציבורי - אבל רק תוך 24 שעות)
app.get('/api/receipt/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT filename, file_data, content_type FROM receipts WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).send('הקבלה לא נמצאה או שפג תוקפה (24 שעות)');
    }

    const receipt = result.rows[0];
    
    res.setHeader('Content-Type', receipt.content_type);
    res.setHeader('Content-Disposition', `inline; filename="${receipt.filename}"`);
    res.send(receipt.file_data);
    
  } catch (err) {
    console.error('Error fetching receipt:', err);
    res.status(500).send('שגיאה בטעינת הקבלה');
  }
});

// בדיקת אחריות לפי מספר סריאלי (ציבורי)
app.get('/api/warranty/check/:machineNumber', async (req, res) => {
  const { machineNumber } = req.params;

  if (!machineNumber) {
    return res.status(400).json({ success: false, message: 'לא הוזן מספר סריאלי' });
  }

  try {
    const result = await pool.query(
      'SELECT id, serial_number, purchase_date, customer_name, customer_phone, expiry_date, status, registration_date, product_type FROM warranties WHERE serial_number = $1',
      [machineNumber]
    );

    if (result.rows.length === 0) {
      return res.json({ 
        success: false, 
        message: 'מספר סריאלי לא נמצא במערכת' 
      });
    }

    const warranty = result.rows[0];
    const now = new Date();
    const registrationDate = new Date(warranty.registration_date);
    const hoursPassed = (now - registrationDate) / (1000 * 60 * 60);

    // טיפול לפי סטטוס
    if (warranty.status === 'נדחה') {
      return res.json({
        success: false,
        status: 'נדחה',
        message: 'הרישום נדחה עקב טעות ברישום. נא ליצור קשר.'
      });
    }

    if (warranty.status === 'פג תוקף') {
      return res.json({
        success: false,
        status: 'פג תוקף',
        message: `תוקף האחריות פג ב-${new Date(warranty.expiry_date).toLocaleDateString('he-IL')}`
      });
    }

    if (warranty.status === 'ממתין לאישור') {
      // אם עברו 24 שעות - מציג כבתוקף
      if (hoursPassed >= 24) {
        return res.json({
          success: true,
          status: 'בתוקף',
          serialNumber: warranty.serial_number,
          warrantyDate: new Date(warranty.expiry_date).toLocaleDateString('he-IL'),
          customerName: warranty.customer_name
        });
      } else {
        // פחות מ-24 שעות
        return res.json({
          success: false,
          status: 'ממתין לאישור',
          message: 'המכשיר ממתין לאישור. הבדיקה תסתיים תוך 24 שעות מהרישום.'
        });
      }
    }

    if (warranty.status === 'בתוקף') {
      return res.json({
        success: true,
        status: 'בתוקף',
        serialNumber: warranty.serial_number,
        warrantyDate: new Date(warranty.expiry_date).toLocaleDateString('he-IL'),
        customerName: warranty.customer_name
      });
    }

    // סטטוס לא מוכר
    return res.json({ success: false, message: 'סטטוס לא ידוע' });

  } catch (err) {
    console.error('Error checking warranty:', err);
    res.status(500).json({ success: false, message: 'שגיאה בבדיקת אחריות' });
  }
});

// עדכון סטטוס אחריות (admin בלבד)
app.put('/api/admin/warranty/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['ממתין לאישור', 'בתוקף', 'נדחה', 'פג תוקף'];

  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'סטטוס לא תקין' });
  }

  try {
    const result = await pool.query(
      'UPDATE warranties SET status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'אחריות לא נמצאה' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בעדכון אחריות' });
  }
});

// ===== Admin - Products Management =====

// קבלת מוצר בודד (admin)
app.get('/api/admin/products/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'מוצר לא נמצא' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בשליפת מוצר' });
  }
});

// ===== Admin Endpoints =====

// קבלת כל האחריות (admin)
app.get('/api/admin/warranties', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM warranties 
      ORDER BY registration_date DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בשליפת אחריות' });
  }
});

// עדכון מספר סריאלי (admin)
app.put('/api/admin/warranty/:id/machine-number', authenticateToken, requireAdmin, async (req, res) => {
  const { serial_number } = req.body;
  
  if (!serial_number) {
    return res.status(400).json({ error: 'מספר סריאלי חובה' });
  }

  try {
    // בדיקה שמספר המכשיר לא קיים אצל אחריות אחרת
    const existing = await pool.query(
      'SELECT id FROM warranties WHERE serial_number = $1 AND id != $2',
      [serial_number, req.params.id]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'מספר סריאלי זה כבר קיים' });
    }

    const result = await pool.query(
      'UPDATE warranties SET serial_number = $1 WHERE id = $2 RETURNING *',
      [serial_number, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'אחריות לא נמצאה' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בעדכון מספר סריאלי' });
  }
});

// מחיקת אחריות (admin)
app.delete('/api/admin/warranty/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM warranties WHERE id = $1 RETURNING *',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'אחריות לא נמצאה' });
    }

    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה במחיקת אחריות' });
  }
});

// שיוך אחריות למשתמש (admin)
app.put('/api/admin/warranty/:id/assign-user', authenticateToken, requireAdmin, async (req, res) => {
  const { user_id } = req.body;

  try {
    const result = await pool.query(
      'UPDATE warranties SET user_id = $1 WHERE id = $2 RETURNING *',
      [user_id || null, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'אחריות לא נמצאה' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בשיוך משתמש' });
  }
});

// עדכון תאריכי אחריות (admin)
app.put('/api/admin/warranty/:id/dates', authenticateToken, requireAdmin, async (req, res) => {
  const { purchase_date, expiry_date } = req.body;

  if (!purchase_date || !expiry_date) {
    return res.status(400).json({ error: 'שני התאריכים חובה' });
  }

  try {
    const result = await pool.query(
      'UPDATE warranties SET purchase_date = $1, expiry_date = $2 WHERE id = $3 RETURNING *',
      [purchase_date, expiry_date, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'אחריות לא נמצאה' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בעדכון תאריכים' });
  }
});

// קבלת פרטי הזמנה מלאים (admin)
app.get('/api/admin/order/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const orderResult = await pool.query(`
      SELECT o.*, u.full_name, u.email, u.phone
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      WHERE o.id = $1
    `, [req.params.id]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    }

    const itemsResult = await pool.query(`
      SELECT oi.*, p.name as product_name, p.image_url
      FROM order_items oi
      LEFT JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = $1
    `, [req.params.id]);

    const order = orderResult.rows[0];
    order.items = itemsResult.rows;

    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בשליפת הזמנה' });
  }
});

// קבלת כל ההזמנות (admin)
app.get('/api/admin/orders', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.*, u.full_name, u.email 
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      ORDER BY o.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בשליפת הזמנות' });
  }
});

// קבלת כל המשתמשים (admin)
app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, full_name, email, phone, is_admin, created_at 
      FROM users 
      ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בשליפת משתמשים' });
  }
});

// סטטיסטיקות מתקדמות (admin)
app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // סה"כ הכנסות
    const revenueResult = await pool.query(`
      SELECT COALESCE(SUM(total_amount), 0) as total_revenue
      FROM orders
      WHERE status = 'completed'
    `);

    // מוצרים פופולריים
    const popularResult = await pool.query(`
      SELECT p.name, COUNT(oi.id) as sales_count
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      GROUP BY p.id, p.name
      ORDER BY sales_count DESC
      LIMIT 5
    `);

    // הזמנות חודש אחרון
    const monthOrdersResult = await pool.query(`
      SELECT COUNT(*) as count
      FROM orders
      WHERE created_at >= NOW() - INTERVAL '30 days'
    `);

    res.json({
      total_revenue: revenueResult.rows[0].total_revenue,
      popular_products: popularResult.rows,
      orders_last_month: monthOrdersResult.rows[0].count
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בשליפת סטטיסטיקות' });
  }
});

// ===== Cron Jobs =====

// אישור אוטומטי (רץ כל שעתיים)
app.get('/api/cron/auto-approve', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, serial_number, customer_name, customer_phone, purchase_date, registration_date
      FROM warranties
      WHERE status = 'ממתין לאישור'
        AND registration_date < NOW() - INTERVAL '24 hours'
    `);

    let approvedCount = 0;

    // שליחת תזכורת למכשירים ב-22-24 שעות
    const reminderResult = await pool.query(`
      SELECT w.id, w.serial_number, w.customer_name, w.customer_phone, 
             w.purchase_date, w.registration_date, r.id as receipt_id
      FROM warranties w
      LEFT JOIN receipts r ON r.warranty_id = w.id
      WHERE w.status = 'ממתין לאישור'
        AND w.reminder_sent = false
        AND w.registration_date < NOW() - INTERVAL '22 hours'
        AND w.registration_date > NOW() - INTERVAL '24 hours'
    `);

    for (const w of reminderResult.rows) {
      const receiptUrl = w.receipt_id
        ? `https://ecodos-backend-production.up.railway.app/api/receipt/${w.receipt_id}`
        : null;

      if (transporter || emailService) {
        try {
          await sendEmail({
            to: 'info@ecodos.co.il',
            subject: `⚠️ תזכורת - מכשיר ${w.serial_number} יאושר אוטומטית בתוך כשעתיים`,
            text:
              `תזכורת: המכשיר הבא ממתין לאישור ויאושר אוטומטית בעוד כשעתיים:\n\n` +
              `מספר סריאלי: ${w.serial_number}\n` +
              `שם לקוח: ${w.customer_name}\n` +
              `טלפון: ${w.customer_phone}\n` +
              `תאריך רכישה: ${new Date(w.purchase_date).toLocaleDateString('he-IL')}\n` +
              `תאריך רישום: ${new Date(w.registration_date).toLocaleDateString('he-IL')}\n\n` +
              (receiptUrl ? `קבלה: ${receiptUrl}\n(הקישור תקף עד סוף היום)\n\n` : 'לא צורפה קבלה\n\n') +
              `לאישור או דחייה ידנית: https://ecodos.co.il/admin.html`
          });
        } catch (emailErr) {
          console.error('❌ שגיאה בשליחת תזכורת:', emailErr);
        }
      }

      await pool.query('UPDATE warranties SET reminder_sent = true WHERE id = $1', [w.id]);
      console.log(`📧 נשלחה תזכורת: ${w.serial_number}`);
    }

    for (const warranty of result.rows) {
      // שינוי סטטוס לבתוקף
      await pool.query(
        'UPDATE warranties SET status = $1 WHERE id = $2',
        ['בתוקף', warranty.id]
      );

      // שליחת מייל על אישור אוטומטי
      if (transporter || emailService) {
        try {
          await sendEmail({
            to: 'info@ecodos.co.il',
            subject: `אישור אוטומטי - מכשיר ${warranty.serial_number}`,
            text: 
              `מכשיר אושר אוטומטי (עברו 24 שעות):\n\n` +
              `מספר סריאלי: ${warranty.serial_number}\n` +
              `שם לקוח: ${warranty.customer_name}\n` +
              `טלפון: ${warranty.customer_phone}\n` +
              `תאריך רכישה: ${new Date(warranty.purchase_date).toLocaleDateString('he-IL')}\n` +
              `תאריך רישום: ${new Date(warranty.registration_date).toLocaleDateString('he-IL')}\n\n` +
              `הסטטוס שונה ל"בתוקף".`
          });
        } catch (emailError) {
          console.error('❌ שגיאה בשליחת מייל אישור:', emailError);
        }
      }

      approvedCount++;
      console.log(`✅ אושר אוטומטית: ${warranty.serial_number}`);
    }

    console.log(`✅ Cron: אושרו ${approvedCount} מכשירים`);
    res.json({ success: true, approvedCount });

  } catch (err) {
    console.error('❌ Cron error:', err);
    res.status(500).json({ error: 'שגיאה באישור אוטומטי' });
  }
});

// בדיקת פג תוקף (רץ כל יום בחצות)
app.get('/api/cron/check-expired', async (req, res) => {
  try {
    const result = await pool.query(`
      UPDATE warranties
      SET status = 'פג תוקף'
      WHERE status = 'בתוקף'
        AND expiry_date < CURRENT_DATE
      RETURNING id, serial_number
    `);

    console.log(`✅ Cron: ${result.rows.length} מכשירים פג תוקפם`);
    res.json({ success: true, expiredCount: result.rows.length });

  } catch (err) {
    console.error('❌ Cron error:', err);
    res.status(500).json({ error: 'שגיאה בבדיקת פג תוקף' });
  }
});

// Cron Job: מחיקת קבלות ישנות (מעל 24 שעות)
app.get('/api/cron/delete-old-receipts', async (req, res) => {
  try {
    const result = await pool.query(`
      DELETE FROM receipts
      WHERE created_at < NOW() - INTERVAL '24 hours'
      RETURNING id, filename
    `);

    console.log(`✅ Cron: ${result.rows.length} קבלות נמחקו`);
    res.json({ 
      success: true, 
      deleted: result.rows.length,
      message: `${result.rows.length} קבלות נמחקו`
    });

  } catch (err) {
    console.error('❌ Cron error:', err);
    res.status(500).json({ error: 'שגיאה במחיקת קבלות' });
  }
});

// ===== Admin - איפוס סיסמה ידני =====
app.post('/api/admin/reset-user-password', authenticateToken, requireAdmin, async (req, res) => {
  const { user_email, new_password } = req.body;

  if (!user_email || !new_password) {
    return res.status(400).json({ error: 'נדרשים אימייל וסיסמה חדשה' });
  }

  if (new_password.length < 6) {
    return res.status(400).json({ error: 'הסיסמה חייבת להכיל לפחות 6 תווים' });
  }

  try {
    // בדיקה שהמשתמש קיים
    const userResult = await pool.query('SELECT id, full_name FROM users WHERE email = $1', [user_email]);
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'משתמש לא נמצא' });
    }

    // הצפנת הסיסמה החדשה
    const password_hash = await bcrypt.hash(new_password, 10);

    // עדכון הסיסמה
    await pool.query('UPDATE users SET password_hash = $1 WHERE email = $2', [password_hash, user_email]);

    res.json({ 
      message: 'הסיסמה עודכנה בהצלחה',
      user: userResult.rows[0].full_name 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה באיפוס סיסמה' });
  }
});

// ===== Admin - כל ההזמנות =====
app.get('/api/admin/orders', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, u.email, u.full_name,
        json_agg(json_build_object(
          'product_id', oi.product_id,
          'product_name', p.name,
          'quantity', oi.quantity,
          'price', oi.price
        )) as items
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       LEFT JOIN order_items oi ON o.id = oi.order_id
       LEFT JOIN products p ON oi.product_id = p.id
       GROUP BY o.id, u.email, u.full_name
       ORDER BY o.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בשליפת הזמנות' });
  }
});

// עדכון סטטוס הזמנה (admin)
app.put('/api/admin/orders/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { status, payment_status } = req.body;

  try {
    const result = await pool.query(
      'UPDATE orders SET status = $1, payment_status = $2 WHERE id = $3 RETURNING *',
      [status, payment_status, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בעדכון הזמנה' });
  }
});

// ===== Brochure Download Tracking =====

// רישום הורדת עלון
app.post('/api/brochure-download', async (req, res) => {
  const { success, timestamp } = req.body;

  try {
    const downloadTime = timestamp ? new Date(timestamp) : new Date();
    const successStatus = success === true || success === 'true';

    // שליחת מייל על ההורדה
    if (transporter || emailService) {
      sendEmail({
        to: 'info@ecodos.co.il',
        subject: successStatus ? 'עלון הורד בהצלחה - דף עסקים' : 'ניסיון הורדת עלון נכשל',
        text: 
          `התראה: ${successStatus ? 'עלון הורד בהצלחה' : 'ניסיון הורדה נכשל'}\n\n` +
          `זמן: ${downloadTime.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}\n` +
          `מקור: דף עסקים (businesses.html)\n` +
          `סטטוס: ${successStatus ? 'הצליח ✓' : 'נכשל ✗'}`
      }).then(() => {
        console.log('✅ מייל הורדת עלון נשלח');
      }).catch((err) => {
        console.error('❌ שגיאה בשליחת מייל:', err);
      });
    }

    console.log(`📥 הורדת עלון: ${successStatus ? 'הצלחה' : 'כשלון'} - ${downloadTime.toISOString()}`);
    
    res.json({ success: true, message: 'Download tracked' });
  } catch (err) {
    console.error('Error tracking download:', err);
    res.status(500).json({ error: 'שגיאה ברישום הורדה' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'משהו השתבש בשרת' });
});

// הפעלת השרת

// ===== סוגי מוצר =====

// קבלת כל סוגי המוצר (ציבורי)
app.get('/api/product-types', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM product_types ORDER BY sort_order, id');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'שגיאה בטעינת סוגי מוצר' });
  }
});

// הוספת סוג מוצר (admin)
app.post('/api/admin/product-types', authenticateToken, requireAdmin, async (req, res) => {
  const { value, label } = req.body;
  if (!value || !label) return res.status(400).json({ error: 'חסר value או label' });
  try {
    const result = await pool.query(
      'INSERT INTO product_types (value, label) VALUES ($1, $2) RETURNING *',
      [value, label]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'ערך זה כבר קיים' });
    res.status(500).json({ error: 'שגיאה בהוספה' });
  }
});

// מחיקת סוג מוצר (admin)
app.delete('/api/admin/product-types/:value', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM product_types WHERE value = $1', [req.params.value]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'שגיאה במחיקה' });
  }
});


// ===== קטגוריות =====

// קבלת כל הקטגוריות (ציבורי)
app.get('/api/categories', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM categories ORDER BY sort_order, id');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'שגיאה בטעינת קטגוריות' });
  }
});

// הוספת קטגוריה (admin)
app.post('/api/admin/categories', authenticateToken, requireAdmin, async (req, res) => {
  const { value, label } = req.body;
  if (!value || !label) return res.status(400).json({ error: 'חסר value או label' });
  try {
    const result = await pool.query(
      'INSERT INTO categories (value, label) VALUES ($1, $2) RETURNING *',
      [value, label]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'קטגוריה זו כבר קיימת' });
    res.status(500).json({ error: 'שגיאה בהוספה' });
  }
});

// מחיקת קטגוריה (admin)
app.delete('/api/admin/categories/:value', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM categories WHERE value = $1', [req.params.value]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'שגיאה במחיקה' });
  }
});
// צור קשר
app.post('/api/contact', async (req, res) => {
  const { name, phone, email, message } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'חסרים פרטים' });
  try {
    await sendEmail({
      to: 'info@ecodos.co.il',
      subject: `פנייה חדשה מאתר ECODOS - ${name}`,
      text: `שם: ${name}\nטלפון: ${phone || '-'}\nאימייל: ${email}\n\nהודעה:\n${message || '-'}`
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאה בשליחה' });
  }
});

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await initializeDatabase();
});
