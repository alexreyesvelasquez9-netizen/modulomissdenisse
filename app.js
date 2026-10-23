// ==========================================
// CUOTIFY - API REST principal (Node.js + Express)
// ==========================================
// Endpoints expuestos:
//  POST /api/auth/registro            -> registra comunidad + administrador (PÚBLICO, RF-01)
//  POST /api/auth/login               -> inicia sesión (PÚBLICO, RF-02)
//  POST /api/auth/cambiar-clave       -> cambia contraseña propia (RF-03)
//  GET  /api/health                   -> verificación de que la API está viva
//
//  Administrador:
//  GET/POST/PUT /api/viviendas        -> gestión de viviendas (RF-04)
//  GET/POST/PUT /api/conceptos        -> gestión de conceptos (RF-06)
//  GET/POST     /api/residentes       -> gestión de residentes (RF-05)
//  POST /api/residentes/:id/restablecer-clave (RF-05)
//  POST /api/cuotas/generar           -> generación masiva (RF-07)
//  GET  /api/cuotas                   -> listado con filtros (RF-12)
//  POST /api/pagos                    -> registrar pago (RF-08)
//  POST /api/pagos/:id/anular         -> anular pago (RF-09)
//  GET  /api/dashboard/resumen        -> morosidad para la gráfica
//  GET  /api/deudores                 -> viviendas en mora (RF-13)
//  GET  /api/solventes                -> viviendas al día
//  GET/POST /api/recordatorios(/enviar)-> recordatorios (RF-14)
//  GET  /api/reportes?mes=&anio=      -> reportes (RF-15)
//  GET  /api/bitacora                 -> trazabilidad (RF-17)
//
//  Residente:
//  GET  /api/residente/cuotas         -> solo SUS cuotas (RF-11, RF-16)
//  GET  /api/viviendas/:id/estado-cuenta -> solo SU vivienda (RF-16)
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

// ---------- Seguridad general (RNF-03 / RNF-04) ----------
app.use(helmet());            // encabezados HTTP seguros
app.use(cors());              // permite la versión web (GitHub Pages) y el APK
app.use(express.json());

// Límite general: 300 peticiones por minuto por IP
const limiterGeneral = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Demasiadas peticiones. Espere un momento e intente de nuevo.' }
});
app.use('/api', limiterGeneral);

// Límite estricto para el login: 20 intentos cada 5 minutos por IP
const limiterLogin = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Demasiados intentos de ingreso. Espere 5 minutos.' }
});
app.use('/api/auth/login', limiterLogin);

// ---------- Rutas modulares ----------
app.use('/api/auth', authRoutes);        // registro, login, cambiar-clave
app.use('/api', catalogoRoutes);         // viviendas y conceptos
app.use('/api', residentesRoutes);       // residentes
app.use('/api', cuotasRoutes);           // cuotas + estado de cuenta del residente
app.use('/api', pagosRoutes);            // pagos + estado de cuenta por vivienda
app.use('/api', adminRoutes);            // panel, deudores, solventes, reportes, bitácora

// ---------- Verificación de vida (útil para Render) ----------
app.get('/api/health', (req, res) => {
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
