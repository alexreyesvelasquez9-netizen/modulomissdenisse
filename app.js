// ==========================================
// CUOTIFY - API REST principal (Node.js + Express)
// ==========================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./auth.routes');
const catalogoRoutes = require('./catalogo.routes');
const residentesRoutes = require('./residentes.routes');
const cuotasRoutes = require('./cuotas.routes');
const pagosRoutes = require('./pagos.routes');
const adminRoutes = require('./admin.routes');

const app = express();

// ---------- Seguridad general ----------
app.use(helmet());            
app.use(cors());              
app.use(express.json());

// Límite general: 300 peticiones por minuto por IP (aplicado a todas las rutas)
const limiterGeneral = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Demasiadas peticiones. Espere un momento e intente de nuevo.' }
});
app.use(limiterGeneral);

// Límite estricto para el login: 20 intentos cada 5 minutos por IP
const limiterLogin = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Demasiados intentos de ingreso. Espere 5 minutos.' }
});
app.use('/auth/login', limiterLogin);

// ---------- Rutas modulares (SIN /api) ----------
app.use('/auth', authRoutes);       // /auth/login, /auth/registro, /auth/cambiar-clave
app.use('/', catalogoRoutes);        // /viviendas, /conceptos
app.use('/', residentesRoutes);      // /residentes
app.use('/', cuotasRoutes);          // /cuotas, /residente/cuotas
app.use('/', pagosRoutes);           // /pagos
app.use('/', adminRoutes);           // /dashboard/resumen, /deudores, /solventes, etc.

// ---------- Verificación de vida ----------
app.get(['/health', '/api/health'], (req, res) => {
  res.json({ status: 'ok', sistema: 'Cuotify API', hora: new Date().toISOString() });
});

// ---------- Manejador de rutas inexistentes ----------
app.use((req, res) => {
  res.status(404).json({ message: 'Ruta no encontrada.' });
});

// ---------- Manejador global de errores ----------
app.use((error, req, res, next) => {
  console.error('Error no controlado:', error.message);
  res.status(500).json({ message: 'Error interno del servidor', error: error.message });
});

// ---------- Arranque del servidor ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor API REST de Cuotify corriendo en el puerto ${PORT}`);
});
