// ==========================================
// CUOTIFY - Conexión a MySQL (pool de conexiones)
// Lee la configuración desde el archivo .env
// ==========================================
// - MySQL local:      DB_PORT=3306  y  DB_SSL=false
// - TiDB Cloud:       DB_PORT=4000  y  DB_SSL=true
// - Aiven for MySQL:  DB_PORT=<el del panel>  y  DB_SSL=true
// ==========================================
const mysql = require('mysql2/promise');
require('dotenv').config();

const usaSSL = process.env.DB_SSL === 'true';

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT) || 3306,
  ...(usaSSL
    ? { ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true } }
    : {}),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

module.exports = pool;
