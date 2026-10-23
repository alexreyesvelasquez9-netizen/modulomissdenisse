// ==========================================
// CUOTIFY - Rutas de autenticación (montadas en /api/auth)
//  POST /api/auth/registro      -> NUEVO: registra comunidad + administrador
//  POST /api/auth/login         -> inicia sesión (con bloqueo por intentos, RNF-04)
//  POST /api/auth/cambiar-clave -> cambia la contraseña propia (RF-03)
// ==========================================
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('./db');
const {
  JWT_SECRET,
  verificarToken,
  registrarBitacora,
  esCorreoValido
} = require('./auth');

const router = express.Router();

// Configuración del bloqueo por intentos fallidos (RNF-04 / prueba P-02)
const MAX_INTENTOS = 5;      // intentos permitidos
const MINUTOS_BLOQUEO = 15;  // duración del bloqueo temporal

// ==========================================
// ENDPOINT: REGISTRO DE COMUNIDAD + ADMINISTRADOR (RF-01)
// Cualquier persona puede registrar SU comunidad y convertirse en su
// administrador. Todo se crea en una sola transacción: o se crea
// la comunidad con su admin, o no se crea nada.
// ==========================================
router.post('/registro', async (req, res) => {
  try {
    const { comunidad, administrador } = req.body || {};

    // ---------- Validaciones de entrada ----------
    const nombreComunidad = (comunidad?.nombre || '').trim();
    const direccion = (comunidad?.direccion || '').trim();
    const telComunidad = (comunidad?.telefono || '').trim();
    const nombreAdmin = (administrador?.nombre_completo || '').trim();
    const correo = (administrador?.correo || '').trim().toLowerCase();
    const telefonoAdmin = (administrador?.telefono || '').trim();
    const contrasena = administrador?.contrasena || '';

    if (nombreComunidad.length < 3) {
      return res.status(422).json({ message: 'El nombre de la comunidad debe tener al menos 3 caracteres.' });
    }
    if (!nombreAdmin) {
      return res.status(422).json({ message: 'El nombre completo del administrador es obligatorio.' });
    }
    if (!esCorreoValido(correo)) {
      return res.status(422).json({ message: 'Ingrese un correo electrónico válido.' });
    }
    if (contrasena.length < 6) {
      return res.status(422).json({ message: 'La contraseña debe tener al menos 6 caracteres.' });
    }

    // El correo es único en TODO el sistema (un correo no puede administrar dos comunidades)
    const [existe] = await pool.query('SELECT id_usuario FROM usuario WHERE correo = ?', [correo]);
    if (existe.length > 0) {
      return res.status(409).json({ message: 'Ese correo ya está registrado. Use otro o inicie sesión.' });
    }

    // ---------- Transacción: comunidad + administrador ----------
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const [comunidadResult] = await connection.query(
        `INSERT INTO comunidad (nombre, direccion, telefono_contacto) VALUES (?, ?, ?)`,
        [nombreComunidad, direccion || null, telComunidad || null]
      );
      const idComunidad = comunidadResult.insertId;

      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(contrasena, salt);

      const [usuarioResult] = await connection.query(
        `INSERT INTO usuario (id_comunidad, nombre_completo, correo, telefono, contrasena_hash, rol, debe_cambiar_clave)
         VALUES (?, ?, ?, ?, ?, 'administrador', FALSE)`,
        [idComunidad, nombreAdmin, correo, telefonoAdmin || null, hash]
      );

      await connection.query(
        `INSERT INTO bitacora (id_usuario, accion, detalle) VALUES (?, 'registro_comunidad', ?)`,
        [usuarioResult.insertId, `Se registró la comunidad "${nombreComunidad}" con administrador ${correo}`]
      );

      await connection.commit();
      connection.release();

      res.status(201).json({
        mensaje: `Comunidad "${nombreComunidad}" registrada. Ya puede iniciar sesión.`,
        id_comunidad: idComunidad,
        id_usuario: usuarioResult.insertId
      });
    } catch (error) {
      await connection.rollback();
      connection.release();
      throw error;
    }
  } catch (error) {
    res.status(500).json({ message: 'Error al registrar la comunidad', error: error.message });
  }
});

// ==========================================
// ENDPOINT: LOGIN (RF-02, con bloqueo temporal RNF-04)
// ==========================================
router.post('/login', async (req, res) => {
  try {
    const { correo, contrasena } = req.body || {};
    const correoLimpio = (correo || '').trim().toLowerCase();

    const [rows] = await pool.query(
      'SELECT * FROM usuario WHERE correo = ? AND activo = TRUE',
      [correoLimpio]
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: 'Credenciales inválidas.' });
    }

    const usuario = rows[0];

    // ---------- Bloqueo temporal tras 5 intentos (P-02) ----------
    if (usuario.bloqueado_hasta && new Date(usuario.bloqueado_hasta) > new Date()) {
      const minutosRestantes = Math.ceil(
        (new Date(usuario.bloqueado_hasta) - new Date()) / 60000
      );
      return res.status(423).json({
        message: `Cuenta bloqueada temporalmente por intentos fallidos. Intente en ${minutosRestantes} minuto(s).`
      });
    }

    const passwordMatch = await bcrypt.compare(contrasena || '', usuario.contrasena_hash);

    if (!passwordMatch) {
      const intentos = (usuario.intentos_fallidos || 0) + 1;
      if (intentos >= MAX_INTENTOS) {
        // Bloquea la cuenta y reinicia el contador de intentos
        await pool.query(
          'UPDATE usuario SET intentos_fallidos = 0, bloqueado_hasta = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id_usuario = ?',
          [MINUTOS_BLOQUEO, usuario.id_usuario]
        );
        return res.status(423).json({
          message: `Superó ${MAX_INTENTOS} intentos fallidos. Su cuenta está bloqueada por ${MINUTOS_BLOQUEO} minutos.`
        });
      }
      await pool.query(
        'UPDATE usuario SET intentos_fallidos = ? WHERE id_usuario = ?',
        [intentos, usuario.id_usuario]
      );
      const restantes = MAX_INTENTOS - intentos;
      return res.status(401).json({
        message: `Credenciales inválidas. Le quedan ${restantes} intento(s) antes del bloqueo.`
      });
    }

    // ---------- Ingreso correcto: limpiar bloqueos ----------
    await pool.query(
      'UPDATE usuario SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id_usuario = ?',
      [usuario.id_usuario]
    );

    // ---------- Generar token JWT de 8 horas ----------
    const token = jwt.sign(
      { id_usuario: usuario.id_usuario, id_comunidad: usuario.id_comunidad, rol: usuario.rol },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    await registrarBitacora(usuario.id_usuario, 'login', `Inicio de sesión de ${usuario.correo}`);

    res.json({
      token,
      usuario: {
        id_usuario: usuario.id_usuario,
        nombre_completo: usuario.nombre_completo,
        correo: usuario.correo,
        rol: usuario.rol,
        debe_cambiar_clave: !!usuario.debe_cambiar_clave
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Error interno del servidor', error: error.message });
  }
});

// ==========================================
// ENDPOINT: CAMBIAR CONTRASEÑA (RF-03)
// Ahora verifica la contraseña actual antes de cambiar (seguridad).
// ==========================================
router.post('/cambiar-clave', verificarToken, async (req, res) => {
  try {
    const { clave_actual, clave_nueva } = req.body || {};

    if (!clave_nueva || clave_nueva.length < 6) {
      return res.status(422).json({ message: 'La nueva contraseña debe tener al menos 6 caracteres.' });
    }

    const [rows] = await pool.query(
      'SELECT contrasena_hash FROM usuario WHERE id_usuario = ?',
      [req.usuario.id_usuario]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado.' });
    }

    const coincide = await bcrypt.compare(clave_actual || '', rows[0].contrasena_hash);
    if (!coincide) {
      return res.status(401).json({ message: 'La contraseña actual no es correcta.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(clave_nueva, salt);

    await pool.query(
      'UPDATE usuario SET contrasena_hash = ?, debe_cambiar_clave = FALSE WHERE id_usuario = ?',
      [hash, req.usuario.id_usuario]
    );

    await registrarBitacora(req.usuario.id_usuario, 'cambio_clave', 'El usuario cambió su contraseña');

    res.json({ mensaje: 'Contraseña actualizada exitosamente.' });
  } catch (error) {
    res.status(500).json({ message: 'Error al cambiar la contraseña', error: error.message });
  }
});

module.exports = router;
