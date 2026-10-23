// ==========================================
// CUOTIFY - Middlewares de autenticación y utilidades
// ==========================================
const jwt = require('jsonwebtoken');
const pool = require('./db');

// ------------------------------------------
// Secreto JWT: en producción es OBLIGATORIO definir JWT_SECRET.
// Si falta, el servidor se niega a arrancar (fix de seguridad).
// ------------------------------------------
const JWT_SECRET = (() => {
  const secreto = process.env.JWT_SECRET;
  if (!secreto && process.env.NODE_ENV === 'production') {
    throw new Error('FATAL: define JWT_SECRET en el archivo .env antes de desplegar en producción.');
  }
  return secreto || 'secreto_super_seguro_solo_desarrollo';
})();

// ------------------------------------------
// verificarToken: valida el header "Authorization: Bearer <token>"
// y deja en req.usuario = { id_usuario, id_comunidad, rol }
// ------------------------------------------
const verificarToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Token de autenticación requerido.' });
  }

  jwt.verify(token, JWT_SECRET, (err, usuario) => {
    if (err) return res.status(403).json({ message: 'Token inválido o expirado.' });
    req.usuario = usuario; // { id_usuario, id_comunidad, rol }
    next();
  });
};

// ------------------------------------------
// soloAdministrador: bloquea rutas de gestión a residentes (P-03)
// ------------------------------------------
const soloAdministrador = (req, res, next) => {
  if (req.usuario.rol !== 'administrador') {
    return res.status(403).json({ message: 'Acceso denegado. Se requiere rol de administrador.' });
  }
  next();
};

// ------------------------------------------
// registrarBitacora: guarda acciones críticas (RF-17).
// Nunca interrumpe el flujo: si falla, solo se registra en consola.
// ------------------------------------------
async function registrarBitacora(idUsuario, accion, detalle) {
  try {
    await pool.query(
      'INSERT INTO bitacora (id_usuario, accion, detalle) VALUES (?, ?, ?)',
      [idUsuario || null, accion, (detalle || '').substring(0, 400)]
    );
  } catch (e) {
    console.error('Bitácora no registrada:', e.message);
  }
}

// ------------------------------------------
// generarClaveTemporal: clave legible de 8 caracteres (RF-05)
// ------------------------------------------
function generarClaveTemporal() {
  const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sin I ni O para confundir menos
  const digitos = '23456789';                 // sin 0 ni 1
  let clave = '';
  for (let i = 0; i < 4; i++) {
    clave += letras.charAt(Math.floor(Math.random() * letras.length));
  }
  clave += '-';
  for (let i = 0; i < 4; i++) {
    clave += digitos.charAt(Math.floor(Math.random() * digitos.length));
  }
  return clave; // Ejemplo: KTRM-7342
}

// ------------------------------------------
// esCorreoValido: validación simple de formato de correo
// ------------------------------------------
function esCorreoValido(correo) {
  return typeof correo === 'string' && /^[\w.+\-]+@[\w\-]+\.[\w.\-]+$/.test(correo);
}

module.exports = {
  JWT_SECRET,
  verificarToken,
  soloAdministrador,
  registrarBitacora,
  generarClaveTemporal,
  esCorreoValido
};
