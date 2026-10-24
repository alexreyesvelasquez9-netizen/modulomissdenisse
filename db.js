// ==========================================
// CUOTIFY - Conexión a MySQL (pool de conexiones)
// ==========================================
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const usaSSL = process.env.DB_SSL === 'true';

let sslOptions = undefined;
if (usaSSL) {
  sslOptions = {
    minVersion: 'TLSv1.2',
    rejectUnauthorized: process.env.DB_REJECT_UNAUTHORIZED !== 'false'
  };

  // Si existe el certificado ISRG Root X1 en la carpeta raíz, lo carga automáticamente
  const certPath = path.join(__dirname, 'isrgrootx1.pem');
  if (fs.existsSync(certPath)) {
    sslOptions.ca = fs.readFileSync(certPath);
  }
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT) || 3306,
  ...(sslOptions ? { ssl: sslOptions } : {}),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

module.exports = pool;
