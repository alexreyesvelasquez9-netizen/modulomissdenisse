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

// Indicar a Express que confíe en el proxy inverso de Render (indispensable para rate-limit)
app.set('trust proxy', 1);

// ---------- Seguridad y CORS ----------
// Desactivamos restricciones de recursos cruzados en Helmet para que Flutter Web funcione sin bloqueos
app.use(helmet({
  crossOriginResourcePolicy: false,
  crossOriginEmbedderPolicy: false
}));

// Configuración unificada de CORS
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
};

app.use(cors(corsOptions));
// Atiende inmediatamente el sondeo preliminar (preflight) que hace el navegador en Flutter Web
app.options('*', cors(corsOptions));

app.use(express.json());

// Límite general
const limiterGeneral = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Demasiadas peticiones. Espere un momento e intente de nuevo.' }
});
app.use('/api', limiterGeneral);

// Límite login
const limiterLogin = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Demasiados intentos de ingreso. Espere 5 minutos.' }
});
app.use('/api/auth/login', limiterLogin);

// ---------- Verificación de vida (soporta múltiples variantes) ----------
const respuestaHealth = (req, res) => {
  res.json({ status: 'ok', sistema: 'Cuotify API', hora: new Date().toISOString() });
};

app.get('/', respuestaHealth);
app.get('/health', respuestaHealth);
app.get('/api', respuestaHealth);
app.get('/api/health', respuestaHealth);

// ---------- Rutas modulares ----------
app.use('/api/auth', authRoutes);
app.use('/api', catalogoRoutes);
app.use('/api', residentesRoutes);
app.use('/api', cuotasRoutes);
app.use('/api', pagosRoutes);
app.use('/api', adminRoutes);

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
